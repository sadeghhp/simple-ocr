/**
 * Application layer (spec §6.2): orchestrates upload, processing, editing,
 * deletion, export and import. No raw IndexedDB or provider wire code here.
 */
import { ERROR_CODES, AppError, toAppError } from '@/lib/errors';
import {
  DOCUMENT_STATUS,
  createDocumentRecord,
  deleteDocumentAndFile,
  getDocument,
  listDocuments,
  putDocument,
  updateDocument,
} from '@/lib/db/documents';
import { createFileRecord, deleteFile, getFile, putFile } from '@/lib/db/files';
import { getSetting, setSetting, SETTINGS_KEYS } from '@/lib/db/settings';
import { validateFile } from '@/lib/files/validation';
import { runOcr } from '@/lib/providers/adapter';
import { deleteDatabase } from '@/lib/db/database';

/**
 * Validate and store one uploaded file: blob first, then the metadata
 * record (spec §8 steps 1–2). Returns the new document record.
 */
export async function uploadFile(file) {
  const { mimeType } = validateFile(file);
  const fileId = crypto.randomUUID();
  const docId = crypto.randomUUID();

  await putFile(
    createFileRecord({ id: fileId, blob: file, name: file.name, mimeType, size: file.size })
  );
  const doc = createDocumentRecord({
    id: docId,
    fileId,
    name: file.name,
    mimeType,
    size: file.size,
  });
  try {
    await putDocument(doc);
  } catch (err) {
    // Do not leave an orphaned blob if the metadata write fails.
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
const inFlight = new Set();

/**
 * Recover documents left mid-processing by a closed tab or a crash. The
 * in-flight guard is per-tab and in memory, so a persisted `processing` status
 * has no owner after a reload and would otherwise disable the document forever.
 */
export async function reconcileInterruptedProcessing() {
  const docs = await listDocuments();
  const stuck = docs.filter(
    (doc) => doc.status === DOCUMENT_STATUS.processing && !inFlight.has(doc.id)
  );
  for (const doc of stuck) {
    await updateDocument(doc.id, {
      status: DOCUMENT_STATUS.failed,
      processingError: new AppError(
        ERROR_CODES.PROCESSING_INTERRUPTED,
        'Processing did not finish before the app closed',
        { retryable: true, documentId: doc.id }
      ).toRecord(),
    });
  }
  return stuck.length;
}

export function isProcessing(documentId) {
  return inFlight.has(documentId);
}

/**
 * Run OCR for a document (spec §8 steps 3–6). Marks the document
 * `processing`, calls the provider, stores the normalized result or a
 * normalized error. Never touches the original file record.
 */
export async function processDocument(documentId) {
  if (inFlight.has(documentId)) {
    throw new AppError(ERROR_CODES.ALREADY_PROCESSING, 'Processing already in progress', {
      documentId,
    });
  }
  inFlight.add(documentId);
  try {
    const doc = await getDocument(documentId);
    if (!doc) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Document not found', { documentId });
    }
    const config = await getSetting(SETTINGS_KEYS.provider);
    const fileRecord = await getFile(doc.fileId);
    if (!fileRecord) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Original file not found', { documentId });
    }

    await updateDocument(documentId, {
      status: DOCUMENT_STATUS.processing,
      processingError: null,
    });

    try {
      const result = await runOcr(
        fileRecord.blob,
        { mimeType: fileRecord.mimeType, name: fileRecord.name },
        config
      );
      return await updateDocument(documentId, {
        status: DOCUMENT_STATUS.completed,
        extractedText: result.text,
        editedText: result.text,
        providerName: result.provider,
        model: result.model,
        processedAt: result.processedAt,
        processingError: null,
      });
    } catch (err) {
      const appError = toAppError(err, ERROR_CODES.PROVIDER_ERROR);
      // Failure must preserve the file and any previous extraction (spec §8 step 6).
      await updateDocument(documentId, (current) => ({
        status: DOCUMENT_STATUS.failed,
        processingError: appError.toRecord(),
        extractedText: current.extractedText,
        editedText: current.editedText,
      }));
      throw appError;
    }
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

/** Delete a document and every related record (spec §4.11). */
export function deleteDocument(documentId) {
  return deleteDocumentAndFile(documentId);
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
