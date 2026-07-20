// @vitest-environment node
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, deleteDatabase } from '@/lib/db/database';
import { listAllDocuments } from '@/lib/db/documents';
import { listFiles } from '@/lib/db/files';
import { buildExportBlob, buildManifest } from '@/lib/export/exporter';
import { parseArchive, restoreArchive, validateManifest } from '@/lib/export/importer';
import { saveProviderConfig, uploadFile } from '@/lib/workflows';
import { emptyProviderConfig } from '@/lib/providers/validation';

const makeFile = (name = 'scan.png') =>
  new File([new Uint8Array([9, 8, 7])], name, { type: 'image/png' });

beforeEach(async () => {
  await deleteDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('buildManifest', () => {
  it('includes versions and file paths, and never provider credentials', () => {
    const manifest = buildManifest(
      [{ id: 'd1', fileId: 'f1', name: 'a.png' }],
      [{ id: 'f1', name: 'a.png', mimeType: 'image/png', size: 3, createdAt: 'x', blob: new Blob() }],
      { now: '2026-01-01T00:00:00.000Z' }
    );
    expect(manifest.exportVersion).toBe(1);
    expect(manifest.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(manifest.files[0].path).toBe('files/f1');
    expect(manifest.files[0].blob).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('apiKey');
  });
});

describe('validateManifest', () => {
  const validManifest = () => ({
    exportVersion: 1,
    applicationVersion: '0.1.0',
    createdAt: 'x',
    documents: [
      {
        id: 'd1',
        fileId: 'f1',
        name: 'a.png',
        mimeType: 'image/png',
        size: 3,
        createdAt: 'x',
        status: 'ready',
      },
    ],
    files: [{ id: 'f1', name: 'a.png', mimeType: 'image/png', size: 3, createdAt: 'x' }],
  });

  it('accepts a valid manifest', () => {
    expect(validateManifest(validManifest())).toEqual({ documentCount: 1, fileCount: 1 });
  });

  it.each([
    ['wrong version', (m) => (m.exportVersion = 99)],
    ['missing documents', (m) => delete m.documents],
    ['missing required field', (m) => delete m.documents[0].mimeType],
    ['duplicate document ids', (m) => m.documents.push({ ...m.documents[0] })],
    ['dangling file reference', (m) => (m.documents[0].fileId = 'nope')],
    ['non-text extraction', (m) => (m.documents[0].extractedText = { html: '<b>x</b>' })],
    // A file entry typed text/html becomes the Content-Type of a blob: URL,
    // which the preview would load in this origin.
    [
      'an executable file type',
      (m) => {
        m.files[0].mimeType = 'text/html';
        m.documents[0].mimeType = 'text/html';
      },
    ],
    [
      'a type disagreement between document and file entry',
      (m) => (m.files[0].mimeType = 'text/html'),
    ],
    ['an svg file type', (m) => ((m.files[0].mimeType = 'image/svg+xml'), (m.documents[0].mimeType = 'image/svg+xml'))],
    ['an unknown status', (m) => (m.documents[0].status = 'banana')],
    ['an oversized file', (m) => (m.files[0].size = 999 * 1024 * 1024)],
  ])('rejects %s', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateManifest(manifest)).toThrowError(
      expect.objectContaining({ code: 'IMPORT_INVALID' })
    );
  });
});

describe('export → import round trip', () => {
  it('restores documents and files from an export archive', async () => {
    await saveProviderConfig({
      ...emptyProviderConfig(),
      endpoint: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'secret-key',
    });
    const doc = await uploadFile(makeFile('roundtrip.png'));

    const { blob } = await buildExportBlob();

    // The archive must not leak the API key (spec §4.12).
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifestText = await zip.file('manifest.json').async('string');
    expect(manifestText).not.toContain('secret-key');

    await deleteDatabase();

    const parsed = await parseArchive(blob);
    expect(parsed.summary).toEqual({ documentCount: 1, fileCount: 1 });
    const { imported } = await restoreArchive(parsed);
    expect(imported).toBe(1);

    const docs = await listAllDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe('roundtrip.png');
    expect(docs[0].id).toBe(doc.id);
    const files = await listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].blob.size).toBe(3);
  });

  it('imports duplicates as copies with fresh ids', async () => {
    await uploadFile(makeFile('dup.png'));
    const { blob } = await buildExportBlob();
    const parsed = await parseArchive(blob);
    await restoreArchive(parsed);
    const docs = await listAllDocuments();
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map((d) => d.id)).size).toBe(2);
    expect(new Set(docs.map((d) => d.fileId)).size).toBe(2);
  });

  it('stores the blob with the validated document type, not a manifest-supplied one', async () => {
    await uploadFile(makeFile('typed.png'));
    const { blob } = await buildExportBlob();
    await deleteDatabase();
    await restoreArchive(await parseArchive(blob));
    const files = await listFiles();
    expect(files[0].blob.type).toBe('image/png');
    expect(files[0].mimeType).toBe('image/png');
  });

  it('rejects a non-zip file with IMPORT_INVALID', async () => {
    await expect(parseArchive(new Blob(['not a zip']))).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
  });

  it('rejects an archive missing a binary', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        exportVersion: 1,
        documents: [
          {
            id: 'd1',
            fileId: 'f1',
            name: 'a.png',
            mimeType: 'image/png',
            size: 3,
            createdAt: 'x',
            status: 'ready',
          },
        ],
        files: [{ id: 'f1', name: 'a.png', mimeType: 'image/png', size: 3, createdAt: 'x' }],
      })
    );
    const blob = await zip.generateAsync({ type: 'blob' });
    await expect(parseArchive(blob)).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
  });
});
