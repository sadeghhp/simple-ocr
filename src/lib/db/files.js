/**
 * Original file store. Blobs are stored unchanged and never mutated after
 * upload (spec §4.2). Loaded only when a document is previewed or processed.
 */
import { STORES, requestToPromise, withTransaction } from '@/lib/db/database';

export function createFileRecord({ id, blob, name, mimeType, size }) {
  return {
    id,
    blob,
    name,
    mimeType,
    size,
    createdAt: new Date().toISOString(),
  };
}

export function putFile(fileRecord) {
  return withTransaction([STORES.files], 'readwrite', (tx) =>
    requestToPromise(tx.objectStore(STORES.files).put(fileRecord))
  );
}

export async function getFile(id) {
  const file = await withTransaction([STORES.files], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.files).get(id))
  );
  return file ?? null;
}

export function deleteFile(id) {
  return withTransaction([STORES.files], 'readwrite', (tx) =>
    requestToPromise(tx.objectStore(STORES.files).delete(id))
  );
}

export async function listFiles() {
  const files = await withTransaction([STORES.files], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.files).getAll())
  );
  return files || [];
}
