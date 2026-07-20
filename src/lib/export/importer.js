/**
 * Import a previously exported archive (spec §4.12, §19, §28).
 * Everything is validated before anything is written to IndexedDB.
 */
import JSZip from 'jszip';
import { AppError, ERROR_CODES, toAppError } from '@/lib/errors';
import { SUPPORTED_EXPORT_VERSIONS } from '@/lib/export/exporter';
import {
  DOCUMENT_KIND,
  DOCUMENT_STATUS,
  deleteDocumentTree,
  getDocument,
  putDocument,
} from '@/lib/db/documents';
import { deleteFile, getFile, putFile } from '@/lib/db/files';
import { migrateDocumentRecord } from '@/lib/db/migrations';
import { deriveParentStatus } from '@/lib/pipeline/status';
import { TEMPLATE_IDS } from '@/lib/extraction/templates';
import { MAX_FILE_BYTES, isSupportedMimeType } from '@/lib/files/validation';

const REQUIRED_DOC_FIELDS = ['id', 'fileId', 'name', 'mimeType', 'size', 'createdAt', 'status'];

/**
 * Bring every document in a manifest to the current schema.
 * A v1 archive takes exactly the same migration path as a v1 database, so the
 * two cannot drift apart.
 */
function migrateManifestDocuments(manifest) {
  return {
    ...manifest,
    documents: manifest.documents.map((doc) => migrateDocumentRecord(doc)),
  };
}

/**
 * Validate a parsed manifest (pure; unit-testable).
 * Throws AppError(IMPORT_INVALID) with a specific reason on failure.
 */
export function validateManifest(manifest) {
  // The validation reasons are already user-facing, so they double as the hint.
  const fail = (reason) => {
    throw new AppError(ERROR_CODES.IMPORT_INVALID, reason, { hint: reason });
  };
  if (!manifest || typeof manifest !== 'object') fail('The archive has no readable manifest.');
  if (!SUPPORTED_EXPORT_VERSIONS.includes(manifest.exportVersion)) {
    fail(`Unsupported export version: ${manifest.exportVersion ?? 'missing'}.`);
  }
  if (!Array.isArray(manifest.documents)) fail('The manifest has no document list.');
  if (!Array.isArray(manifest.files)) fail('The manifest has no file list.');

  const fileIds = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.id !== 'string' || !file.id) fail('A file entry has no id.');
    if (fileIds.has(file.id)) fail(`Duplicate file id in archive: ${file.id}.`);
    // An unchecked MIME type here becomes the Content-Type of a blob: URL,
    // which the preview can load in the app's own origin.
    if (!isSupportedMimeType(file.mimeType)) {
      fail(`File "${file.name || file.id}" has an unsupported type: ${file.mimeType}.`);
    }
    if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
      fail(`File "${file.name || file.id}" exceeds the maximum size.`);
    }
    fileIds.add(file.id);
  }

  const docIds = new Set();
  for (const doc of manifest.documents) {
    if (!doc || typeof doc !== 'object') fail('A document record is malformed.');
    for (const field of REQUIRED_DOC_FIELDS) {
      if (doc[field] === undefined || doc[field] === null || doc[field] === '') {
        fail(`Document "${doc.name || doc.id || '?'}" is missing the "${field}" field.`);
      }
    }
    if (docIds.has(doc.id)) fail(`Duplicate document id in archive: ${doc.id}.`);
    docIds.add(doc.id);
    if (!fileIds.has(doc.fileId)) {
      fail(`Document "${doc.name}" references a file that is not in the archive.`);
    }
    if (!isSupportedMimeType(doc.mimeType)) {
      fail(`Document "${doc.name}" has an unsupported type: ${doc.mimeType}.`);
    }
    // The renderer is chosen from the document's type while the blob carries
    // the file entry's type; a mismatch is how a preview gets the wrong one.
    const fileEntry = manifest.files.find((f) => f.id === doc.fileId);
    if (fileEntry && fileEntry.mimeType !== doc.mimeType) {
      fail(`Document "${doc.name}" disagrees with its file entry about the file type.`);
    }
    if (!Object.values(DOCUMENT_STATUS).includes(doc.status)) {
      fail(`Document "${doc.name}" has an unknown status: ${doc.status}.`);
    }
    if (doc.extractedText != null && typeof doc.extractedText !== 'string') {
      fail(`Document "${doc.name}" has a non-text extraction result.`);
    }
    if (doc.editedText != null && typeof doc.editedText !== 'string') {
      fail(`Document "${doc.name}" has a non-text edited result.`);
    }
    if (doc.extraction != null && (typeof doc.extraction !== 'object' || Array.isArray(doc.extraction))) {
      fail(`Document "${doc.name}" has a malformed extraction record.`);
    }
    if (doc.documentType != null && !TEMPLATE_IDS.includes(doc.documentType)) {
      fail(`Document "${doc.name}" has an unknown document type: ${doc.documentType}.`);
    }
  }

  // Parent/child integrity. A broken reference here would produce pages that
  // are invisible in the sidebar but still occupy storage.
  const byId = new Map(manifest.documents.map((doc) => [doc.id, doc]));
  const pagesByParent = new Map();
  for (const doc of manifest.documents) {
    if (!doc.parentId) continue;
    if (doc.parentId === doc.id) fail(`Document "${doc.name}" lists itself as its parent.`);

    const parent = byId.get(doc.parentId);
    if (!parent) fail(`Page "${doc.name}" references a parent that is not in the archive.`);
    if (parent.kind !== DOCUMENT_KIND.parent) {
      fail(`Page "${doc.name}" references a document that is not a multi-page parent.`);
    }
    if (!Number.isInteger(doc.pageNumber) || doc.pageNumber < 1) {
      fail(`Page "${doc.name}" has an invalid page number: ${doc.pageNumber}.`);
    }
    if (!pagesByParent.has(doc.parentId)) pagesByParent.set(doc.parentId, new Set());
    const seen = pagesByParent.get(doc.parentId);
    if (seen.has(doc.pageNumber)) {
      fail(`Document "${parent.name}" has two copies of page ${doc.pageNumber}.`);
    }
    seen.add(doc.pageNumber);
  }

  for (const doc of manifest.documents) {
    if (doc.kind !== DOCUMENT_KIND.parent) continue;
    const pageCount = pagesByParent.get(doc.id)?.size ?? 0;
    if (pageCount === 0) fail(`Document "${doc.name}" is marked multi-page but has no pages.`);
  }

  return {
    documentCount: manifest.documents.length,
    rootCount: manifest.documents.filter((doc) => !doc.parentId).length,
    fileCount: manifest.files.length,
  };
}

/**
 * Read and fully validate an archive file without writing anything.
 * Returns `{ manifest, zip, summary }` ready for `restoreArchive`.
 */
export async function parseArchive(archiveFile) {
  let zip;
  try {
    const data =
      typeof archiveFile?.arrayBuffer === 'function'
        ? await archiveFile.arrayBuffer()
        : archiveFile;
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    throw new AppError(ERROR_CODES.IMPORT_INVALID, 'The file is not a readable zip archive.', {
      cause: err,
      hint: 'Choose the .zip file produced by the Export action.',
      detail: err?.message ?? null,
    });
  }
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) {
    throw new AppError(ERROR_CODES.IMPORT_INVALID, 'The archive has no manifest.json.', {
      hint: 'This zip file was not created by Simple OCR — it has no manifest.json.',
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(await manifestEntry.async('string'));
  } catch (err) {
    throw new AppError(ERROR_CODES.IMPORT_INVALID, 'manifest.json is not valid JSON.', {
      cause: err,
      hint: 'The archive’s manifest.json is corrupted.',
      detail: err?.message ?? null,
    });
  }
  if (!parsed || !Array.isArray(parsed.documents)) {
    throw new AppError(ERROR_CODES.IMPORT_INVALID, 'The manifest has no document list.', {
      hint: 'The manifest has no document list.',
    });
  }
  // Migrate before validating, so an older archive is checked against the rules
  // it will actually be stored under.
  const manifest = migrateManifestDocuments(parsed);
  const summary = validateManifest(manifest);
  for (const file of manifest.files) {
    if (!zip.file(`files/${file.id}`)) {
      const reason = `The archive is missing the binary for "${file.name || file.id}".`;
      throw new AppError(ERROR_CODES.IMPORT_INVALID, reason, { hint: reason });
    }
  }
  return { manifest, zip, summary };
}

/**
 * Restore a parsed archive into IndexedDB. Documents whose id already exists
 * locally get fresh ids so imports never overwrite existing data.
 *
 * Three passes, and the ordering is load-bearing. Remapping ids inside a single
 * write loop cannot work once documents share a file or reference each other:
 * every page of a PDF names the same fileId, so a per-document remap would
 * store the same blob once per page under a different id each time, and a
 * page's parentId would still point at the parent's *old* id — orphaning every
 * page in the archive.
 */
export async function restoreArchive({ manifest, zip }) {
  const written = { documents: [], files: [] };

  // Pass 1 — decide every id up front, so later passes only ever look up.
  const docIdMap = new Map();
  for (const doc of manifest.documents) {
    docIdMap.set(doc.id, (await getDocument(doc.id)) ? crypto.randomUUID() : doc.id);
  }
  const fileIdMap = new Map();
  for (const file of manifest.files) {
    fileIdMap.set(file.id, (await getFile(file.id)) ? crypto.randomUUID() : file.id);
  }

  const rollback = async () => {
    for (const id of written.documents) await deleteDocumentTree(id).catch(() => {});
    for (const id of written.files) await deleteFile(id).catch(() => {});
  };

  const fail = async (err, imported) => {
    await rollback();
    const error = toAppError(err, ERROR_CODES.STORAGE_ERROR);
    error.hint =
      imported > 0
        ? `The import was rolled back after ${imported} of ${manifest.documents.length} documents; nothing was added.`
        : error.hint;
    throw error;
  };

  // Pass 2 — write each distinct blob exactly once, never once per document.
  try {
    for (const file of manifest.files) {
      const binary = await zip.file(`files/${file.id}`).async('arraybuffer');
      // validateManifest guarantees the type is allowlisted and agrees with
      // every document pointing at it.
      const blob = new Blob([binary], { type: file.mimeType });
      const fileId = fileIdMap.get(file.id);
      await putFile({
        id: fileId,
        blob,
        name: file.name,
        mimeType: file.mimeType,
        size: blob.size,
        createdAt: file.createdAt,
      });
      written.files.push(fileId);
    }
  } catch (err) {
    await fail(err, 0);
  }

  // Pass 3 — parents before pages, with every reference remapped.
  const ordered = [
    ...manifest.documents.filter((doc) => !doc.parentId),
    ...manifest.documents.filter((doc) => doc.parentId),
  ];
  const importedChildren = new Map();
  let imported = 0;

  for (const doc of ordered) {
    const record = {
      ...doc,
      id: docIdMap.get(doc.id),
      fileId: fileIdMap.get(doc.fileId),
      parentId: doc.parentId ? docIdMap.get(doc.parentId) : null,
      // A document exported mid-processing resumes as ready.
      status: doc.status === DOCUMENT_STATUS.processing ? DOCUMENT_STATUS.ready : doc.status,
    };
    try {
      await putDocument(record);
    } catch (err) {
      await fail(err, imported);
    }
    written.documents.push(record.id);
    if (record.parentId) {
      if (!importedChildren.has(record.parentId)) importedChildren.set(record.parentId, []);
      importedChildren.get(record.parentId).push(record);
    }
    imported += 1;
  }

  // Parent status is derived, never trusted from the archive — a hand-edited
  // manifest could otherwise claim `completed` for a document with failed pages.
  for (const [parentId, pages] of importedChildren) {
    const parent = await getDocument(parentId);
    if (!parent) continue;
    await putDocument({
      ...parent,
      status: deriveParentStatus(pages),
      pageCount: pages.length,
    });
  }

  return { imported, rootCount: manifest.documents.filter((doc) => !doc.parentId).length };
}
