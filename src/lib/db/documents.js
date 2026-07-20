/**
 * Document metadata store. List views load metadata only — original file
 * blobs live in the separate files store (spec §7.2).
 */
import { AppError, ERROR_CODES } from '@/lib/errors';
import { SCHEMA_VERSION, STORES, requestToPromise, withTransaction } from '@/lib/db/database';

export const DOCUMENT_STATUS = {
  uploaded: 'uploaded',
  ready: 'ready',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
};

export function createDocumentRecord({ id, fileId, name, mimeType, size }) {
  const now = new Date().toISOString();
  return {
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

/** All documents, newest first. Metadata only — no blobs live here. */
export async function listDocuments() {
  const docs = await withTransaction([STORES.documents], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.documents).getAll())
  );
  return (docs || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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

/** Delete a document and its original file in one coordinated transaction (spec §8 step 8). */
export function deleteDocumentAndFile(id) {
  return withTransaction([STORES.documents, STORES.files], 'readwrite', async (tx) => {
    const docStore = tx.objectStore(STORES.documents);
    const doc = await requestToPromise(docStore.get(id));
    if (!doc) return;
    await requestToPromise(docStore.delete(id));
    if (doc.fileId) {
      await requestToPromise(tx.objectStore(STORES.files).delete(doc.fileId));
    }
  });
}
