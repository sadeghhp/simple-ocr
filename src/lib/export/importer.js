/**
 * Import a previously exported archive (spec §4.12, §19, §28).
 * Everything is validated before anything is written to IndexedDB.
 */
import JSZip from 'jszip';
import { AppError, ERROR_CODES, toAppError } from '@/lib/errors';
import { EXPORT_VERSION } from '@/lib/export/exporter';
import { DOCUMENT_STATUS, getDocument, putDocument } from '@/lib/db/documents';
import { deleteFile, getFile, putFile } from '@/lib/db/files';
import { SCHEMA_VERSION } from '@/lib/db/database';
import { MAX_FILE_BYTES, isSupportedMimeType } from '@/lib/files/validation';

const REQUIRED_DOC_FIELDS = ['id', 'fileId', 'name', 'mimeType', 'size', 'createdAt', 'status'];

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
  if (manifest.exportVersion !== EXPORT_VERSION) {
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
  }
  return { documentCount: manifest.documents.length, fileCount: manifest.files.length };
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
  let manifest;
  try {
    manifest = JSON.parse(await manifestEntry.async('string'));
  } catch (err) {
    throw new AppError(ERROR_CODES.IMPORT_INVALID, 'manifest.json is not valid JSON.', {
      cause: err,
      hint: 'The archive’s manifest.json is corrupted.',
      detail: err?.message ?? null,
    });
  }
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
 * locally get fresh ids (both document and file) so imports never overwrite.
 */
export async function restoreArchive({ manifest, zip }) {
  let imported = 0;
  for (const doc of manifest.documents) {
    const fileMeta = manifest.files.find((f) => f.id === doc.fileId);
    const binary = await zip.file(`files/${doc.fileId}`).async('arraybuffer');
    // validateManifest guarantees doc.mimeType is allowlisted and agrees with
    // the file entry, so it is the single source of truth for the blob type.
    const blob = new Blob([binary], { type: doc.mimeType });

    // Regenerate either id independently — a colliding file id would otherwise
    // overwrite an unrelated document's stored blob.
    const docId = (await getDocument(doc.id)) ? crypto.randomUUID() : doc.id;
    const fileId = (await getFile(doc.fileId)) ? crypto.randomUUID() : doc.fileId;

    await putFile({
      id: fileId,
      blob,
      name: fileMeta?.name ?? doc.name,
      mimeType: doc.mimeType,
      size: blob.size,
      createdAt: fileMeta?.createdAt ?? doc.createdAt,
    });
    try {
      await putDocument({
        ...doc,
        id: docId,
        fileId,
        // A document exported mid-processing resumes as ready.
        status:
          doc.status === DOCUMENT_STATUS.processing ? DOCUMENT_STATUS.ready : doc.status,
        schemaVersion: doc.schemaVersion ?? SCHEMA_VERSION,
      });
    } catch (err) {
      // Do not leave a blob with no document pointing at it.
      await deleteFile(fileId).catch(() => {});
      const error = toAppError(err, ERROR_CODES.STORAGE_ERROR);
      // Report what did land, so a partial import is not described as none.
      error.hint =
        imported > 0
          ? `${imported} ${imported === 1 ? 'document' : 'documents'} imported before this failure; the rest were not.`
          : error.hint;
      throw error;
    }
    imported += 1;
  }
  return { imported };
}
