// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DB_NAME,
  SCHEMA_VERSION,
  STORES,
  closeDatabase,
  deleteDatabase,
  requestToPromise,
  withTransaction,
} from '@/lib/db/database';
import {
  DOCUMENT_KIND,
  createDocumentRecord,
  createPageRecord,
  deleteDocumentTree,
  getDocument,
  listAllDocuments,
  listChildDocuments,
  listRootDocuments,
  putDocument,
} from '@/lib/db/documents';
import { migrateDocumentRecord, v2Defaults } from '@/lib/db/migrations';
import { createFileRecord, getFile, putFile } from '@/lib/db/files';

beforeEach(async () => {
  await deleteDatabase();
});

afterEach(() => {
  closeDatabase();
});

/** A document record exactly as schema v1 wrote it — no v2 fields at all. */
const v1Record = (id = 'doc-v1') => ({
  id,
  fileId: `file-${id}`,
  name: 'legacy-scan.png',
  mimeType: 'image/png',
  size: 1234,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'completed',
  extractedText: 'legacy text',
  editedText: 'legacy text edited',
  providerName: 'Old Provider',
  model: 'old-model',
  processedAt: '2026-01-01T00:00:00.000Z',
  processingError: null,
  schemaVersion: 1,
});

describe('migrateDocumentRecord', () => {
  it('adds every v2 field without disturbing v1 data', () => {
    const migrated = migrateDocumentRecord(v1Record());

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.kind).toBe(DOCUMENT_KIND.single);
    expect(migrated.parentId).toBeNull();
    expect(migrated.pageNumber).toBeNull();
    expect(migrated.ownsFile).toBe(true);
    expect(migrated.extraction).toBeNull();
    expect(migrated.extractionWarnings).toEqual([]);

    // The v1 payload must survive verbatim — this is the whole point.
    expect(migrated.extractedText).toBe('legacy text');
    expect(migrated.editedText).toBe('legacy text edited');
    expect(migrated.providerName).toBe('Old Provider');
    expect(migrated.id).toBe('doc-v1');
  });

  it('is idempotent and never downgrades an already-migrated record', () => {
    const page = { ...v1Record(), ...v2Defaults(), kind: DOCUMENT_KIND.page, pageNumber: 7, schemaVersion: 2 };
    const once = migrateDocumentRecord(page);
    // Migrating twice must be indistinguishable from migrating once, whatever
    // the current SCHEMA_VERSION is — asserting a literal version here would
    // turn every future bump into a test edit.
    expect(migrateDocumentRecord(once)).toEqual(once);
    expect(once.schemaVersion).toBe(SCHEMA_VERSION);
    expect(once.pageNumber).toBe(7);
  });

  it('treats a pre-v3 record as never renamed', () => {
    const migrated = migrateDocumentRecord({ ...v1Record(), ...v2Defaults(), schemaVersion: 2 });
    expect(migrated.originalName).toBe(migrated.name);
    expect(migrated.nameLocked).toBe(false);
  });
});

describe('database upgrade v1 -> v2', () => {
  /** Build a genuine v1 database with the v1 schema, then let the app upgrade it. */
  async function seedV1Database(records) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const documents = db.createObjectStore(STORES.documents, { keyPath: 'id' });
        documents.createIndex('createdAt', 'createdAt');
        documents.createIndex('status', 'status');
        documents.createIndex('name', 'name');
        db.createObjectStore(STORES.files, { keyPath: 'id' });
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction([STORES.documents], 'readwrite');
        records.forEach((record) => tx.objectStore(STORES.documents).put(record));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  it('backfills existing records and creates the parent indexes', async () => {
    await seedV1Database([v1Record('a'), v1Record('b')]);

    // First open through the app triggers the v2 upgrade.
    const docs = await listAllDocuments();
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
      expect(doc.kind).toBe(DOCUMENT_KIND.single);
      expect(doc.ownsFile).toBe(true);
    }
    expect(docs.find((d) => d.id === 'a').extractedText).toBe('legacy text');

    // The new indexes must exist and be usable.
    const indexNames = await withTransaction([STORES.documents], 'readonly', (tx) =>
      Array.from(tx.objectStore(STORES.documents).indexNames)
    );
    expect(indexNames).toContain('parentId');
    expect(indexNames).toContain('parentPage');
  });

  /**
   * A database already at v3 holding v2 records — the state of every existing
   * install before this change. Record migration only runs during a
   * versionchange transaction, so this is the case that proves the DB_VERSION
   * bump actually reaches those records.
   */
  async function seedV3Database(records) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        const documents = db.createObjectStore(STORES.documents, { keyPath: 'id' });
        documents.createIndex('createdAt', 'createdAt');
        documents.createIndex('status', 'status');
        documents.createIndex('name', 'name');
        documents.createIndex('parentId', 'parentId');
        documents.createIndex('parentPage', ['parentId', 'pageNumber']);
        db.createObjectStore(STORES.files, { keyPath: 'id' });
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction([STORES.documents], 'readwrite');
        records.forEach((record) => tx.objectStore(STORES.documents).put(record));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  it('backfills originalName onto records already at v2', async () => {
    await seedV3Database([
      { ...v1Record('a'), ...v2Defaults(), name: 'scan_0012.pdf', schemaVersion: 2 },
    ]);

    const [doc] = await listAllDocuments();
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    // An existing document has never been renamed, so its name is its original
    // — without this it could be auto-renamed with no way back.
    expect(doc.originalName).toBe('scan_0012.pdf');
    expect(doc.nameLocked).toBe(false);
    expect(doc.extractedText).toBe('legacy text');
  });

  it('leaves migrated v1 documents out of the child index', async () => {
    await seedV1Database([v1Record('a')]);
    // parentId is null, and IndexedDB skips null keys — so roots are simply
    // absent from the index rather than needing a sentinel value.
    expect(await listChildDocuments('a')).toEqual([]);
    expect(await listRootDocuments()).toHaveLength(1);
  });
});

describe('parent / page records', () => {
  async function seedParentWithPages(pageCount = 3) {
    const fileId = 'file-1';
    await putFile(
      createFileRecord({
        id: fileId,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
        name: 'multi.pdf',
        mimeType: 'application/pdf',
        size: 3,
      })
    );
    const parent = createDocumentRecord({
      id: 'parent-1',
      fileId,
      name: 'multi.pdf',
      mimeType: 'application/pdf',
      size: 3,
      kind: DOCUMENT_KIND.parent,
      pageCount,
    });
    await putDocument(parent);
    for (let n = 1; n <= pageCount; n += 1) {
      await putDocument(createPageRecord({ id: `page-${n}`, parent, pageNumber: n }));
    }
    return parent;
  }

  it('lists pages in page order and keeps them out of the root list', async () => {
    await seedParentWithPages(3);

    const roots = await listRootDocuments();
    expect(roots.map((d) => d.id)).toEqual(['parent-1']);

    const pages = await listChildDocuments('parent-1');
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(pages.every((p) => p.ownsFile === false)).toBe(true);
    // Pages share the parent's blob and its MIME type, which keeps the export
    // manifest's document/file type-agreement check valid.
    expect(pages.every((p) => p.fileId === 'file-1')).toBe(true);
    expect(pages.every((p) => p.mimeType === 'application/pdf')).toBe(true);
  });

  it('deletes a parent together with all of its pages and its blob', async () => {
    await seedParentWithPages(3);
    await deleteDocumentTree('parent-1');

    expect(await getDocument('parent-1')).toBeNull();
    expect(await listChildDocuments('parent-1')).toEqual([]);
    expect(await listAllDocuments()).toEqual([]);
    expect(await getFile('file-1')).toBeNull();
  });

  it('deleting one page never touches the shared blob or its siblings', async () => {
    await seedParentWithPages(3);
    await deleteDocumentTree('page-2');

    // The ownsFile guard is what protects the siblings here: without it the
    // page deletion would take the parent's blob with it.
    expect(await getFile('file-1')).not.toBeNull();
    expect(await getDocument('page-1')).not.toBeNull();
    expect(await getDocument('page-3')).not.toBeNull();
    expect(await getDocument('parent-1')).not.toBeNull();
    expect(await getDocument('page-2')).toBeNull();
  });

  it('still deletes the blob for a plain single-file document', async () => {
    await putFile(
      createFileRecord({
        id: 'file-solo',
        blob: new Blob([new Uint8Array([9])], { type: 'image/png' }),
        name: 'solo.png',
        mimeType: 'image/png',
        size: 1,
      })
    );
    await putDocument(
      createDocumentRecord({
        id: 'solo',
        fileId: 'file-solo',
        name: 'solo.png',
        mimeType: 'image/png',
        size: 1,
      })
    );

    await deleteDocumentTree('solo');
    expect(await getDocument('solo')).toBeNull();
    expect(await getFile('file-solo')).toBeNull();
  });
});
