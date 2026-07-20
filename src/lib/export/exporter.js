/**
 * Export all local data as a zip archive (spec §4.12, §28):
 *   manifest.json      — export metadata + document records
 *   files/<fileId>     — original binaries
 * Provider credentials are never included.
 */
import JSZip from 'jszip';
import { listAllDocuments } from '@/lib/db/documents';
import { listFiles } from '@/lib/db/files';

/** Bumped to 2 for multi-page documents (parent/child records). */
export const EXPORT_VERSION = 2;
/** Archives this build can still read. v1 records are migrated on import. */
export const SUPPORTED_EXPORT_VERSIONS = [1, 2];
export const APP_VERSION = '0.1.0';

/** Build the manifest object from document + file records (pure; unit-testable). */
export function buildManifest(documents, files, { now = new Date().toISOString() } = {}) {
  return {
    exportVersion: EXPORT_VERSION,
    applicationVersion: APP_VERSION,
    createdAt: now,
    documents: documents.map((doc) => ({ ...doc })),
    files: files.map(({ id, name, mimeType, size, createdAt }) => ({
      id,
      name,
      mimeType,
      size,
      createdAt,
      path: `files/${id}`,
    })),
  };
}

export async function buildExportBlob() {
  // Every document including child pages. Exporting roots only would lose
  // every page of every multi-page document, silently.
  const [documents, files] = await Promise.all([listAllDocuments(), listFiles()]);
  const manifest = buildManifest(documents, files);
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const folder = zip.folder('files');
  for (const file of files) {
    // ArrayBuffer rather than Blob: JSZip handles it in every environment.
    folder.file(file.id, await file.blob.arrayBuffer());
  }
  const content = await zip.generateAsync({ type: 'arraybuffer' });
  const blob = new Blob([content], { type: 'application/zip' });
  return {
    blob,
    documentCount: documents.length,
    // What the user actually uploaded. Counting pages would report "4
    // documents" for one three-page PDF.
    rootCount: documents.filter((doc) => !doc.parentId).length,
    fileCount: files.length,
  };
}

/** Trigger a browser download of the export archive. */
export async function downloadExport() {
  const { blob, rootCount } = await buildExportBlob();
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `simple-ocr-export-${stamp}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Delay revocation so the download can start.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { documentCount: rootCount };
}
