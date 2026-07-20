// @vitest-environment node
// Node for the same reason as tests/multipage.test.js: a jsdom Blob does not
// survive fake-indexeddb's structured clone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, deleteDatabase } from '@/lib/db/database';
import {
  getDocument,
  listAllDocuments,
  listChildDocuments,
  listRootDocuments,
} from '@/lib/db/documents';
import { listFiles } from '@/lib/db/files';
import { buildExportBlob } from '@/lib/export/exporter';
import { parseArchive, restoreArchive, validateManifest } from '@/lib/export/importer';
import { clearCache } from '@/lib/pdf/cache';
import { __setPdfjsLoader } from '@/lib/pdf/render';
import { uploadFile } from '@/lib/workflows';

const pdfFile = (name = 'multi.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });

function stubPdf(numPages) {
  __setPdfjsLoader(async () => ({
    GlobalWorkerOptions: { workerPort: {}, workerSrc: '' },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages,
        getPage: async () => ({
          getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => {},
        }),
        destroy: async () => {},
      }),
    }),
  }));
}

/** Export everything currently stored, then parse it back. */
async function roundTrip() {
  const { blob } = await buildExportBlob();
  return parseArchive(blob);
}

beforeEach(async () => {
  await deleteDatabase();
  clearCache();
  stubPdf(3);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('exporting a multi-page document', () => {
  it('includes every page but only one copy of the shared blob', async () => {
    const parent = await uploadFile(pdfFile());
    const { manifest, summary } = await roundTrip();

    expect(summary.documentCount).toBe(4); // parent + 3 pages
    // What the user uploaded, which is what the success message should report.
    expect(summary.rootCount).toBe(1);
    // Pages share the parent's blob, so there is exactly one binary.
    expect(summary.fileCount).toBe(1);
    expect(manifest.exportVersion).toBe(2);

    const pages = manifest.documents.filter((doc) => doc.parentId === parent.id);
    expect(pages.map((p) => p.pageNumber).sort()).toEqual([1, 2, 3]);
    expect(pages.every((p) => p.fileId === parent.fileId)).toBe(true);
  });

  it('restores the parent, its pages, and their references after a wipe', async () => {
    const parent = await uploadFile(pdfFile());
    const parsed = await roundTrip();

    await deleteDatabase();
    closeDatabase();

    const { imported } = await restoreArchive(parsed);
    expect(imported).toBe(4);

    const roots = await listRootDocuments();
    expect(roots).toHaveLength(1);
    expect(roots[0].kind).toBe('parent');

    const pages = await listChildDocuments(roots[0].id);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // Every page must point at the restored parent and the restored blob.
    expect(pages.every((p) => p.parentId === roots[0].id)).toBe(true);
    expect(pages.every((p) => p.fileId === roots[0].fileId)).toBe(true);
    expect(await listFiles()).toHaveLength(1);
    expect(parent.id).toBe(roots[0].id); // ids kept when there is no collision
  });

  it('remaps parent references when every id collides', async () => {
    // Importing into a database that already holds the archive forces new ids
    // for both the parent and its pages. This is the case the old
    // per-document remap got wrong: it left every page pointing at the
    // parent's original id, orphaning all of them.
    const original = await uploadFile(pdfFile());
    const parsed = await roundTrip();

    const { imported } = await restoreArchive(parsed);
    expect(imported).toBe(4);

    const roots = await listRootDocuments();
    expect(roots).toHaveLength(2);

    const restored = roots.find((doc) => doc.id !== original.id);
    expect(restored).toBeTruthy();

    const restoredPages = await listChildDocuments(restored.id);
    expect(restoredPages).toHaveLength(3);
    expect(restoredPages.every((p) => p.parentId === restored.id)).toBe(true);

    // The original document's pages must be untouched.
    expect(await listChildDocuments(original.id)).toHaveLength(3);
    expect(await listAllDocuments()).toHaveLength(8);

    // One new blob, not one per page — the old code stored it three times.
    expect(await listFiles()).toHaveLength(2);
    expect(restoredPages.every((p) => p.fileId === restored.fileId)).toBe(true);
    expect(restored.fileId).not.toBe(original.fileId);
  });

  it('re-derives parent status rather than trusting the archive', async () => {
    const parent = await uploadFile(pdfFile());
    const parsed = await roundTrip();

    // A hand-edited manifest claiming success for unprocessed pages.
    parsed.manifest.documents.find((d) => d.id === parent.id).status = 'completed';

    await deleteDatabase();
    closeDatabase();
    await restoreArchive(parsed);

    const restored = (await listRootDocuments())[0];
    expect(restored.status).toBe('ready'); // derived from its untouched pages
  });
});

describe('manifest validation of parent/child records', () => {
  const manifestWith = (mutate) => {
    const manifest = {
      exportVersion: 2,
      applicationVersion: '0.1.0',
      createdAt: '2026-07-20T10:00:00.000Z',
      files: [
        {
          id: 'file-1',
          name: 'multi.pdf',
          mimeType: 'application/pdf',
          size: 4,
          createdAt: '2026-07-20T10:00:00.000Z',
          path: 'files/file-1',
        },
      ],
      documents: [
        {
          id: 'parent-1',
          fileId: 'file-1',
          name: 'multi.pdf',
          mimeType: 'application/pdf',
          size: 4,
          createdAt: '2026-07-20T10:00:00.000Z',
          status: 'ready',
          kind: 'parent',
          parentId: null,
          pageNumber: null,
          pageCount: 2,
          schemaVersion: 2,
        },
        ...[1, 2].map((n) => ({
          id: `page-${n}`,
          fileId: 'file-1',
          name: `multi.pdf — page ${n}`,
          mimeType: 'application/pdf',
          size: 0,
          createdAt: '2026-07-20T10:00:00.000Z',
          status: 'ready',
          kind: 'page',
          parentId: 'parent-1',
          pageNumber: n,
          ownsFile: false,
          schemaVersion: 2,
        })),
      ],
    };
    mutate?.(manifest);
    return manifest;
  };

  it('accepts a well-formed multi-page manifest', () => {
    expect(validateManifest(manifestWith())).toEqual({
      documentCount: 3,
      rootCount: 1,
      fileCount: 1,
    });
  });

  it.each([
    [
      'a page whose parent is absent',
      (m) => {
        m.documents[1].parentId = 'ghost';
      },
      /references a parent that is not in the archive/,
    ],
    [
      'a page pointing at a non-parent document',
      (m) => {
        m.documents[0].kind = 'single';
      },
      /not a multi-page parent/,
    ],
    [
      'a self-referencing document',
      (m) => {
        m.documents[1].parentId = 'page-1';
      },
      /lists itself as its parent/,
    ],
    [
      'two copies of the same page number',
      (m) => {
        m.documents[2].pageNumber = 1;
      },
      /two copies of page 1/,
    ],
    [
      'a non-integer page number',
      (m) => {
        m.documents[1].pageNumber = 1.5;
      },
      /invalid page number/,
    ],
    [
      'a parent with no pages at all',
      (m) => {
        m.documents = [m.documents[0]];
      },
      /marked multi-page but has no pages/,
    ],
    [
      'an unknown document type',
      (m) => {
        m.documents[1].documentType = 'shipping_manifest';
      },
      /unknown document type/,
    ],
    [
      'a malformed extraction record',
      (m) => {
        m.documents[1].extraction = 'not an object';
      },
      /malformed extraction record/,
    ],
  ])('rejects %s', (_label, mutate, pattern) => {
    expect(() => validateManifest(manifestWith(mutate))).toThrowError(pattern);
  });
});

describe('backwards compatibility', () => {
  it('imports a v1 archive by migrating its records', async () => {
    // A v1 manifest: no kind, parentId, or extraction fields anywhere.
    const manifest = {
      exportVersion: 1,
      applicationVersion: '0.1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      files: [
        {
          id: 'legacy-file',
          name: 'scan.png',
          mimeType: 'image/png',
          size: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
          path: 'files/legacy-file',
        },
      ],
      documents: [
        {
          id: 'legacy-doc',
          fileId: 'legacy-file',
          name: 'scan.png',
          mimeType: 'image/png',
          size: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'completed',
          extractedText: 'legacy text',
          editedText: 'legacy text',
          schemaVersion: 1,
        },
      ],
    };

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.folder('files').file('legacy-file', new Uint8Array([1, 2, 3, 4]).buffer);
    const archive = new Blob([await zip.generateAsync({ type: 'arraybuffer' })], {
      type: 'application/zip',
    });

    const parsed = await parseArchive(archive);
    await restoreArchive(parsed);

    const restored = await getDocument('legacy-doc');
    expect(restored.schemaVersion).toBe(2);
    expect(restored.kind).toBe('single');
    expect(restored.ownsFile).toBe(true);
    // The v1 payload must survive the migration untouched.
    expect(restored.extractedText).toBe('legacy text');
  });
});
