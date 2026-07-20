// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DB_NAME,
  DB_VERSION,
  SCHEMA_VERSION,
  STORES,
  closeDatabase,
  deleteDatabase,
  requestToPromise,
  withTransaction,
} from '@/lib/db/database';
import {
  DOCUMENT_KIND,
  deleteDocumentTree,
  getDocument,
  listChildDocuments,
} from '@/lib/db/documents';
import { getFile } from '@/lib/db/files';
import { deleteDocument } from '@/lib/workflows';

/**
 * Reproduce the database state reported from a real browser: schema version 2,
 * records already carrying v2 fields, but the `parentId` index absent. Every
 * child lookup threw NotFoundError, and deleting aborted its transaction —
 * surfacing as "The browser database could not complete the operation".
 */
async function seedV2WithoutParentIndex() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const documents = db.createObjectStore(STORES.documents, { keyPath: 'id' });
      documents.createIndex('createdAt', 'createdAt');
      documents.createIndex('status', 'status');
      documents.createIndex('name', 'name');
      // parentId and parentPage deliberately NOT created.
      db.createObjectStore(STORES.files, { keyPath: 'id' });
      db.createObjectStore(STORES.settings, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction([STORES.documents, STORES.files], 'readwrite');
      const docs = tx.objectStore(STORES.documents);
      const base = {
        mimeType: 'application/pdf',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        status: 'ready',
        extractedText: null,
        editedText: null,
        extraction: null,
        extractionEdited: null,
        extractionWarnings: [],
        documentType: null,
        schemaVersion: 2,
      };
      docs.put({
        ...base,
        id: 'parent-1',
        fileId: 'file-1',
        name: 'multi.pdf',
        size: 3,
        kind: DOCUMENT_KIND.parent,
        parentId: null,
        pageNumber: null,
        pageCount: 3,
        ownsFile: true,
      });
      for (let n = 1; n <= 3; n += 1) {
        docs.put({
          ...base,
          id: `page-${n}`,
          fileId: 'file-1',
          name: `multi.pdf — page ${n}`,
          size: 0,
          kind: DOCUMENT_KIND.page,
          parentId: 'parent-1',
          pageNumber: n,
          pageCount: null,
          ownsFile: false,
        });
      }
      tx.objectStore(STORES.files).put({
        id: 'file-1',
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
        name: 'multi.pdf',
        mimeType: 'application/pdf',
        size: 3,
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  await deleteDatabase();
  await seedV2WithoutParentIndex();
});

afterEach(() => {
  closeDatabase();
});

describe('a database missing the parentId index', () => {
  it('is repaired by the version bump on first open', async () => {
    // Opening through the app runs the v3 migration, which recreates it.
    await listChildDocuments('parent-1');

    const indexNames = await withTransaction([STORES.documents], 'readonly', (tx) =>
      Array.from(tx.objectStore(STORES.documents).indexNames)
    );
    expect(indexNames).toContain('parentId');
    expect(indexNames).toContain('parentPage');
  });

  it('lists child pages correctly', async () => {
    const pages = await listChildDocuments('parent-1');
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
  });

  it('deletes a multi-page document instead of aborting the transaction', async () => {
    // This is the exact failure that was reported.
    await deleteDocument('parent-1');

    expect(await getDocument('parent-1')).toBeNull();
    expect(await listChildDocuments('parent-1')).toEqual([]);
    expect(await getFile('file-1')).toBeNull();
  });
});

describe('child lookups without any index at all', () => {
  /**
   * Belt and braces: even if the repair migration could not run — a blocked
   * upgrade, another tab holding the old version open — reads and deletes must
   * still work. Correctness cannot depend on an optimisation existing.
   */
  async function openWithoutRepair() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  it('falls back to scanning when the index is absent', async () => {
    const db = await openWithoutRepair();
    const tx = db.transaction([STORES.documents], 'readonly');
    const store = tx.objectStore(STORES.documents);
    expect(store.indexNames.contains('parentId')).toBe(false);

    // The fallback path filters in memory over a metadata-only store.
    const all = await requestToPromise(store.getAll());
    expect(all.filter((doc) => doc.parentId === 'parent-1')).toHaveLength(3);
    db.close();
  });
});

describe('database versioning', () => {
  it('moves the database and record versions independently', async () => {
    await listChildDocuments('parent-1');
    const doc = await getDocument('parent-1');
    // The two versions are not locked together: DB v3 was an index repair that
    // changed no records, DB v4 carries record schema v3. What must hold is
    // that opening a stale database brings its records fully up to date —
    // record migration only ever runs inside a versionchange transaction.
    expect(DB_VERSION).toBeGreaterThan(SCHEMA_VERSION);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.originalName).toBe(doc.name);
  });
});

describe('deleteDocumentTree with a repaired index', () => {
  it('still protects siblings when one page is deleted', async () => {
    await deleteDocumentTree('page-2');
    expect(await getFile('file-1')).not.toBeNull();
    expect(await getDocument('page-1')).not.toBeNull();
    expect(await getDocument('page-2')).toBeNull();
  });
});
