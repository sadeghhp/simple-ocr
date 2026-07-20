/**
 * Document metadata store. List views load metadata only — original file
 * blobs live in the separate files store (spec §7.2).
 */
import { AppError, ERROR_CODES } from '@/lib/errors';
import { SCHEMA_VERSION, STORES, requestToPromise, withTransaction } from '@/lib/db/database';
import { DOCUMENT_KIND, v2Defaults } from '@/lib/db/migrations';

export { DOCUMENT_KIND };

export const DOCUMENT_STATUS = {
  uploaded: 'uploaded',
  ready: 'ready',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  /** Parent only: some pages succeeded and some failed. */
  partial: 'partial',
};

export function createDocumentRecord({ id, fileId, name, mimeType, size, kind, pageCount }) {
  const now = new Date().toISOString();
  return {
    ...v2Defaults(),
    id,
    fileId,
    name,
    mimeType,
    size,
    createdAt: now,
    updatedAt: now,
    status: DOCUMENT_STATUS.ready,
    extractedText: null,
    editedText: null,
    providerName: null,
    model: null,
    processedAt: null,
    processingError: null,
    kind: kind ?? DOCUMENT_KIND.single,
    pageCount: pageCount ?? null,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * One page of a multi-page parent.
 *
 * A page owns no blob: it carries the parent's `fileId` with `ownsFile: false`
 * and is rasterized on demand. Persisting page images would multiply storage
 * several times over for a cache that pdf.js can rebuild in milliseconds, and
 * quota exhaustion is the failure that actually breaks a browser-only app.
 *
 * `mimeType` is the parent's (application/pdf) so the export manifest's
 * document/file type-agreement check — a security-relevant validation — keeps
 * holding. Preview picks its renderer from `kind`, not `mimeType`.
 */
export function createPageRecord({ id, parent, pageNumber }) {
  const now = new Date().toISOString();
  return {
    ...v2Defaults(),
    id,
    fileId: parent.fileId,
    name: `${parent.name} — page ${pageNumber}`,
    mimeType: parent.mimeType,
    size: 0,
    createdAt: now,
    updatedAt: now,
    status: DOCUMENT_STATUS.ready,
    extractedText: null,
    editedText: null,
    providerName: null,
    model: null,
    processedAt: null,
    processingError: null,
    kind: DOCUMENT_KIND.page,
    parentId: parent.id,
    pageNumber,
    ownsFile: false,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function putDocument(doc) {
  return withTransaction([STORES.documents], 'readwrite', (tx) =>
    requestToPromise(tx.objectStore(STORES.documents).put(doc))
  );
}

export async function getDocument(id) {
  const doc = await withTransaction([STORES.documents], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.documents).get(id))
  );
  return doc ?? null;
}

/**
 * Every document including child pages, newest first. Metadata only.
 *
 * Deliberately NOT named `listDocuments`: export, reconciliation and the
 * sidebar each want a different slice, and silently narrowing the old name
 * would have made exports drop every page with no error at all.
 */
export async function listAllDocuments() {
  const docs = await withTransaction([STORES.documents], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.documents).getAll())
  );
  return (docs || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Top-level documents only (no child pages), newest first — the sidebar view. */
export async function listRootDocuments() {
  const docs = await listAllDocuments();
  return docs.filter((doc) => !doc.parentId);
}

/** Pages of one parent, in page order. */
export async function listChildDocuments(parentId) {
  if (!parentId) return [];
  const docs = await withTransaction([STORES.documents], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.documents).index('parentId').getAll(parentId))
  );
  return (docs || []).sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));
}

/**
 * Read-modify-write inside one transaction so concurrent updates cannot
 * clobber each other. `patch` may be an object or a function of the doc.
 */
export function updateDocument(id, patch) {
  return withTransaction([STORES.documents], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.documents);
    const doc = await requestToPromise(store.get(id));
    if (!doc) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Document ${id} not found`, { documentId: id });
    }
    const changes = typeof patch === 'function' ? patch(doc) : patch;
    const updated = { ...doc, ...changes, updatedAt: new Date().toISOString() };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

/**
 * Delete a document, its child pages, and its original file in one coordinated
 * transaction (spec §8 step 8).
 *
 * The `ownsFile` guard is load-bearing: child pages share the parent's blob, so
 * deleting one page must never touch the file — that would silently break every
 * remaining sibling.
 */
export function deleteDocumentTree(id) {
  return withTransaction([STORES.documents, STORES.files], 'readwrite', async (tx) => {
    const docStore = tx.objectStore(STORES.documents);
    const doc = await requestToPromise(docStore.get(id));
    if (!doc) return;

    const children =
      doc.kind === DOCUMENT_KIND.parent
        ? (await requestToPromise(docStore.index('parentId').getAll(id))) || []
        : [];
    for (const child of children) {
      await requestToPromise(docStore.delete(child.id));
    }

    await requestToPromise(docStore.delete(id));
    if (doc.ownsFile !== false && doc.fileId) {
      await requestToPromise(tx.objectStore(STORES.files).delete(doc.fileId));
    }
  });
}
