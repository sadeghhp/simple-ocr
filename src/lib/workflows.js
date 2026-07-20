/**
 * Application layer (spec §6.2): orchestrates upload, processing, editing,
 * deletion, export and import. No raw IndexedDB or provider wire code here.
 */
import { ERROR_CODES, AppError, toAppError } from '@/lib/errors';
import {
  DOCUMENT_KIND,
  DOCUMENT_STATUS,
  createDocumentRecord,
  createPageRecord,
  deleteDocumentTree,
  getDocument,
  listAllDocuments,
  listChildDocuments,
  putDocument,
  updateDocument,
} from '@/lib/db/documents';
import { createFileRecord, deleteFile, getFile, putFile } from '@/lib/db/files';
import { getSetting, setSetting, SETTINGS_KEYS } from '@/lib/db/settings';
import { validateFile } from '@/lib/files/validation';
import { runOcr } from '@/lib/providers/adapter';
import { deleteDatabase } from '@/lib/db/database';
import { MAX_PDF_PAGES, getPageCount, openDocument } from '@/lib/pdf/render';
import { invalidateFile } from '@/lib/pdf/cache';
import { DEFAULT_CONCURRENCY, createMutex, runPool } from '@/lib/pipeline/pool';
import { deriveParentError, deriveParentStatus, joinPageText } from '@/lib/pipeline/status';

/**
 * Validate and store one uploaded file: blob first, then the metadata
 * record (spec §8 steps 1–2). Returns the new document record.
 */
/**
 * Page count for a PDF, or null when it cannot be read.
 *
 * A PDF pdf.js refuses to open is NOT an upload failure: it falls back to a
 * single document sent whole, which some providers handle natively. Rejecting
 * the upload would strand a file the user might still be able to process.
 */
async function detectPageCount(file, mimeType) {
  if (mimeType !== 'application/pdf') return null;
  try {
    const count = await getPageCount(file);
    if (count > MAX_PDF_PAGES) {
      throw new AppError(
        ERROR_CODES.PDF_TOO_MANY_PAGES,
        `This PDF has ${count} pages; the limit is ${MAX_PDF_PAGES}`,
        { detail: `Pages: ${count}. Limit: ${MAX_PDF_PAGES}.` }
      );
    }
    return count;
  } catch (err) {
    if (err instanceof AppError && err.code === ERROR_CODES.PDF_TOO_MANY_PAGES) throw err;
    return null;
  }
}

export async function uploadFile(file) {
  const { mimeType } = validateFile(file);
  const fileId = crypto.randomUUID();
  const docId = crypto.randomUUID();
  const pageCount = await detectPageCount(file, mimeType);
  const isMultiPage = pageCount !== null && pageCount > 0;

  await putFile(
    createFileRecord({ id: fileId, blob: file, name: file.name, mimeType, size: file.size })
  );
  const doc = createDocumentRecord({
    id: docId,
    fileId,
    name: file.name,
    mimeType,
    size: file.size,
    kind: isMultiPage ? DOCUMENT_KIND.parent : DOCUMENT_KIND.single,
    pageCount: isMultiPage ? pageCount : null,
  });
  try {
    await putDocument(doc);
    if (isMultiPage) {
      // Page records are created eagerly but rendered lazily: this is metadata
      // only, so the sidebar can show "12 pages" the moment the file lands.
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        await putDocument(
          createPageRecord({ id: crypto.randomUUID(), parent: doc, pageNumber })
        );
      }
    }
  } catch (err) {
    // Do not leave an orphaned blob or half a page set behind.
    await deleteDocumentTree(docId).catch(() => {});
    await deleteFile(fileId).catch(() => {});
    throw toAppError(err, ERROR_CODES.STORAGE_ERROR);
  }
  return doc;
}

/**
 * Upload several files. Returns `{ created, failures }` where failures is
 * `[{ name, error }]` — one bad file never blocks the others.
 */
export async function uploadFiles(fileList) {
  const created = [];
  const failures = [];
  for (const file of Array.from(fileList)) {
    try {
      created.push(await uploadFile(file));
    } catch (err) {
      failures.push({ name: file.name, error: toAppError(err) });
    }
  }
  return { created, failures };
}

// Documents with an OCR request currently in flight (per-tab duplicate guard).
// Maps id -> AbortController so a run can be cancelled, not just detected.
const inFlight = new Map();

/**
 * Recover documents left mid-processing by a closed tab or a crash. The
 * in-flight guard is per-tab and in memory, so a persisted `processing` status
 * has no owner after a reload and would otherwise disable the document forever.
 */
export async function reconcileInterruptedProcessing() {
  // Must be the full list, not roots only — a stuck child page has no other
  // owner and would stay disabled forever.
  const docs = await listAllDocuments();
  const stuck = docs.filter(
    (doc) => doc.status === DOCUMENT_STATUS.processing && !inFlight.has(doc.id)
  );

  // Pages first: a parent's status is derived, so it must be recomputed only
  // after its children have settled.
  const pages = stuck.filter((doc) => doc.kind === DOCUMENT_KIND.page);
  const others = stuck.filter((doc) => doc.kind !== DOCUMENT_KIND.page);

  // Everything here reached `processing`, which means a request was genuinely
  // in flight — pages never reached stay `ready` and never appear in this list.
  // So each one gets the interrupted explanation rather than being quietly
  // reset, which would leave the user wondering where their extraction went.
  for (const doc of pages.concat(others.filter((d) => d.kind !== DOCUMENT_KIND.parent))) {
    await updateDocument(doc.id, {
      status: DOCUMENT_STATUS.failed,
      processingError: new AppError(
        ERROR_CODES.PROCESSING_INTERRUPTED,
        'Processing did not finish before the app closed',
        { retryable: true, documentId: doc.id }
      ).toRecord(),
    });
  }

  // Parents are never stamped by hand — always re-derived from their pages.
  const parentIds = new Set([
    ...others.filter((d) => d.kind === DOCUMENT_KIND.parent).map((d) => d.id),
    ...pages.map((p) => p.parentId).filter(Boolean),
  ]);
  for (const parentId of parentIds) {
    await refreshParentStatus(parentId);
  }

  return stuck.length;
}

export function isProcessing(documentId) {
  return inFlight.has(documentId);
}

/** Cancel an in-flight run. For a parent this aborts every page with it. */
export function cancelProcessing(documentId) {
  const controller = inFlight.get(documentId);
  if (controller) controller.abort();
  return Boolean(controller);
}

/** The fields written when a page or document finishes successfully. */
function completionPatch(result) {
  return {
    status: DOCUMENT_STATUS.completed,
    extractedText: result.text,
    editedText: result.text,
    extraction: result.extraction ?? null,
    extractionEdited: null,
    extractionWarnings: result.warnings ?? [],
    documentType: result.extraction?.documentType ?? null,
    providerName: result.provider,
    model: result.model,
    processedAt: result.processedAt,
    processingError: null,
  };
}

/** Record a failure without ever discarding the file or a previous extraction. */
async function recordFailure(documentId, err) {
  const appError = toAppError(err, ERROR_CODES.PROVIDER_ERROR);
  const cancelled = appError.code === ERROR_CODES.PROCESSING_CANCELLED;
  await updateDocument(documentId, (current) => ({
    // A cancelled page was never attempted properly — returning it to `ready`
    // keeps it retryable without dressing a user action up as a failure.
    status: cancelled ? DOCUMENT_STATUS.ready : DOCUMENT_STATUS.failed,
    processingError: cancelled ? null : appError.toRecord(),
    extractedText: current.extractedText,
    editedText: current.editedText,
    extraction: current.extraction,
  })).catch(() => {});
  return appError;
}

/**
 * A gateway that rejects response_format is remembered, so the one-shot
 * downgrade costs one wasted request per provider rather than one per page.
 */
async function rememberJsonModeRejection(config, result) {
  if (!result?.jsonModeRejected || config?.supportsJsonMode === false) return;
  await setSetting(SETTINGS_KEYS.provider, { ...config, supportsJsonMode: false }).catch(() => {});
}

async function loadConfigAndFile(doc) {
  const config = await getSetting(SETTINGS_KEYS.provider);
  const fileRecord = await getFile(doc.fileId);
  if (!fileRecord) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Original file not found', { documentId: doc.id });
  }
  return { config, fileRecord };
}

/** A standalone file: one request, sent whole. Unchanged from v1 behaviour. */
async function processSingle(doc, signal) {
  const { config, fileRecord } = await loadConfigAndFile(doc);
  await updateDocument(doc.id, {
    status: DOCUMENT_STATUS.processing,
    processingError: null,
  });
  try {
    const result = await runOcr(
      fileRecord.blob,
      { mimeType: fileRecord.mimeType, name: fileRecord.name },
      config,
      { signal }
    );
    await rememberJsonModeRejection(config, result);
    return await updateDocument(doc.id, completionPatch(result));
  } catch (err) {
    throw await recordFailure(doc.id, err);
  }
}

/** One page of a parent: rasterize from the shared blob, then extract. */
async function processPage(page, signal, context = null) {
  const parent = context?.parent ?? (await getDocument(page.parentId));
  if (!parent) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Parent document not found', {
      documentId: page.id,
    });
  }
  const config = context?.config ?? (await loadConfigAndFile(parent)).config;

  await updateDocument(page.id, {
    status: DOCUMENT_STATUS.processing,
    processingError: null,
  });

  try {
    let image;
    if (context) {
      // Rendering is serialized even though the requests that follow overlap:
      // pdf.js has one worker, and several large canvases at once is where
      // memory spikes come from.
      image = await context.renderExclusive(() => context.doc.renderPage(page.pageNumber));
    } else {
      const { fileRecord } = await loadConfigAndFile(parent);
      const handle = await openDocument(fileRecord.blob, { signal });
      try {
        image = await handle.renderPage(page.pageNumber);
      } finally {
        await handle.destroy();
      }
    }

    const result = await runOcr(
      image,
      { mimeType: image.type || 'image/jpeg', name: `${parent.name} p${page.pageNumber}` },
      config,
      { signal }
    );
    await rememberJsonModeRejection(config, result);
    return await updateDocument(page.id, completionPatch(result));
  } catch (err) {
    throw await recordFailure(page.id, err);
  }
}

/**
 * Recompute a parent from its pages and refresh its joined text.
 * Called after every page transition, not only at the end of a run — a tab
 * closed mid-document must not leave the parent claiming to be processing.
 */
export async function refreshParentStatus(parentId) {
  const children = await listChildDocuments(parentId);
  const status = deriveParentStatus(children);
  const text = joinPageText(children);
  return updateDocument(parentId, (current) => ({
    status,
    // The parent's text is the concatenation of its pages, so copy and export
    // keep working at the document level with no special-casing.
    extractedText: text || current.extractedText,
    editedText: text || current.editedText,
    pageCount: children.length,
    // Derived, so a document whose pages all failed for one reason reports
    // that reason rather than burying it behind a generic page-failure notice.
    processingError: deriveParentError(children),
  })).catch(() => null);
}

/** Every page of a multi-page document, with bounded concurrency. */
async function processParent(parent, signal, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const pages = await listChildDocuments(parent.id);
  if (pages.length === 0) {
    throw new AppError(ERROR_CODES.PDF_NO_PAGES, 'This document has no pages', {
      documentId: parent.id,
    });
  }
  const { config, fileRecord } = await loadConfigAndFile(parent);

  await updateDocument(parent.id, {
    status: DOCUMENT_STATUS.processing,
    processingError: null,
  });

  // Opened once for the whole document: re-parsing a large PDF per page is the
  // difference between seconds and minutes.
  const handle = await openDocument(fileRecord.blob, { signal });
  const context = {
    parent,
    config,
    doc: handle,
    renderExclusive: createMutex(),
  };

  try {
    await runPool(
      pages,
      async (page) => {
        // Register each page so a per-page Retry during a parent run is
        // correctly refused rather than racing this one.
        inFlight.set(page.id, { abort: () => {} });
        try {
          return await processPage(page, signal, context);
        } finally {
          inFlight.delete(page.id);
          await refreshParentStatus(parent.id);
        }
      },
      { concurrency, signal }
    );
  } finally {
    await handle.destroy();
  }

  return refreshParentStatus(parent.id);
}

/**
 * Run OCR for a document (spec §8 steps 3–6). Dispatches on the record's kind:
 * a parent fans out across its pages, a page renders itself from the shared
 * blob, a single file is sent whole. Stores a normalized result or error and
 * never touches the original file record.
 */
export async function processDocument(documentId, options = {}) {
  if (inFlight.has(documentId)) {
    throw new AppError(ERROR_CODES.ALREADY_PROCESSING, 'Processing already in progress', {
      documentId,
    });
  }

  const doc = await getDocument(documentId);
  if (!doc) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Document not found', { documentId });
  }
  // A page whose parent is mid-run would race the pool for the same record.
  if (doc.parentId && inFlight.has(doc.parentId)) {
    throw new AppError(ERROR_CODES.ALREADY_PROCESSING, 'This document is already being processed', {
      documentId,
    });
  }

  const controller = new AbortController();
  inFlight.set(documentId, controller);
  try {
    if (doc.kind === DOCUMENT_KIND.parent) {
      return await processParent(doc, controller.signal, options);
    }
    if (doc.kind === DOCUMENT_KIND.page) {
      const updated = await processPage(doc, controller.signal);
      await refreshParentStatus(doc.parentId);
      return updated;
    }
    return await processSingle(doc, controller.signal);
  } finally {
    inFlight.delete(documentId);
  }
}

/** Save an edited version of the extracted text (kept separate from the extraction). */
export function saveEditedText(documentId, text) {
  return updateDocument(documentId, { editedText: text });
}

/** Discard edits and restore the original extraction result. */
export function resetEditedText(documentId) {
  return updateDocument(documentId, (doc) => ({ editedText: doc.extractedText }));
}

/**
 * Save edited structured fields.
 *
 * Kept in `extractionEdited` so the model's original `extraction` stays intact
 * and reset works — the same separation `editedText` has from `extractedText`.
 */
export function saveExtractionFields(documentId, fields) {
  return updateDocument(documentId, { extractionEdited: fields });
}

/** Discard field edits and fall back to the model's extraction. */
export function resetExtractionFields(documentId) {
  return updateDocument(documentId, { extractionEdited: null });
}

/** Delete a document and every related record (spec §4.11). */
export async function deleteDocument(documentId) {
  const doc = await getDocument(documentId);
  // Stop any run against this document before its records disappear.
  cancelProcessing(documentId);
  const result = await deleteDocumentTree(documentId);
  // Drop cached page rasters too: the fileId is gone, and leaving them wastes
  // memory until eviction.
  if (doc?.fileId && doc.ownsFile !== false) invalidateFile(doc.fileId);
  return result;
}

export function saveProviderConfig(config) {
  return setSetting(SETTINGS_KEYS.provider, config);
}

export function loadProviderConfig() {
  return getSetting(SETTINGS_KEYS.provider);
}

/** Remove every piece of local application data (spec §15.4). */
export function deleteAllLocalData() {
  return deleteDatabase();
}
