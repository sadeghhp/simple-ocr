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

/**
 * Request the children of `parentId` from an open store.
 *
 * Falls back to scanning when the `parentId` index is absent. A database was
 * found in the wild at v2 with the index missing, and every child lookup threw
 * NotFoundError — including deletion, which then aborted its transaction. The
 * index is an optimisation over a store holding metadata only; correctness must
 * not depend on it existing.
 */
function requestChildren(store, parentId) {
  if (store.indexNames.contains('parentId')) {
    return { request: store.index('parentId').getAll(parentId), filtered: true };
  }
  return { request: store.getAll(), filtered: false };
}

const byPageNumber = (a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0);

/** Pages of one parent, in page order. */
export async function listChildDocuments(parentId) {
  if (!parentId) return [];
  const { docs, filtered } = await withTransaction([STORES.documents], 'readonly', async (tx) => {
    const { request, filtered: usedIndex } = requestChildren(
      tx.objectStore(STORES.documents),
      parentId
    );
    return { docs: await requestToPromise(request), filtered: usedIndex };
  });
  const children = filtered
    ? docs || []
    : (docs || []).filter((doc) => doc.parentId === parentId);
  return children.sort(byPageNumber);
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
  return withTransaction([STORES.documents, STORES.files], 'readwrite', (tx) => {
    const docStore = tx.objectStore(STORES.documents);
    const fileStore = tx.objectStore(STORES.files);

    // Every request is issued from inside an IndexedDB event handler rather
    // than after `await`. Awaiting a promise between requests hands control
    // back to the event loop, and a browser is free to commit the transaction
    // at that point — after which further requests throw
    // TransactionInactiveError. fake-indexeddb is lenient about this, so the
    // await-based version tested clean while failing in a real browser.
    return new Promise((resolve, reject) => {
      const finish = (doc) => {
        docStore.delete(id);
        // Child pages share the parent's blob, so only an owner may delete it.
        if (doc.ownsFile !== false && doc.fileId) fileStore.delete(doc.fileId);
        resolve();
      };

      const getRequest = docStore.get(id);
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        const doc = getRequest.result;
        if (!doc) {
          resolve();
          return;
        }
        if (doc.kind !== DOCUMENT_KIND.parent) {
          finish(doc);
          return;
        }
        // Tolerates a missing parentId index — see requestChildren.
        const { request: childRequest, filtered } = requestChildren(docStore, id);
        childRequest.onerror = () => reject(childRequest.error);
        childRequest.onsuccess = () => {
          const children = filtered
            ? childRequest.result || []
            : (childRequest.result || []).filter((child) => child.parentId === id);
          for (const child of children) docStore.delete(child.id);
          finish(doc);
        };
      };
    });
  });
}
