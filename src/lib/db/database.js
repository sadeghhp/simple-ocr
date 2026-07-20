/**
 * Central IndexedDB access. All database transactions in the app go through
 * this module — UI code must never open its own (spec §6.3, §27).
 */
import { AppError, ERROR_CODES, toAppError } from '@/lib/errors';
import { SCHEMA_VERSION, migrateDocumentRecord } from '@/lib/db/migrations';

export const DB_NAME = 'simple-ocr';
export const DB_VERSION = 2;
export { SCHEMA_VERSION };

export const STORES = {
  documents: 'documents',
  files: 'files',
  settings: 'settings',
};

let dbPromise = null;
// Kept alongside the promise so the connection can be closed synchronously —
// deleteDatabase() is otherwise blocked by our own still-open connection.
let dbInstance = null;

/**
 * Versioned upgrade path. Migrations must be additive and never delete
 * user data (spec §27). Each `if (oldVersion < N)` block is one migration.
 *
 * `tx` is the versionchange transaction — the only way to reach an existing
 * store to add an index or rewrite records.
 */
function upgrade(db, oldVersion, tx) {
  if (oldVersion < 1) {
    const documents = db.createObjectStore(STORES.documents, { keyPath: 'id' });
    documents.createIndex('createdAt', 'createdAt');
    documents.createIndex('status', 'status');
    documents.createIndex('name', 'name');

    db.createObjectStore(STORES.files, { keyPath: 'id' });
    db.createObjectStore(STORES.settings, { keyPath: 'key' });
  }

  if (oldVersion < 2) {
    // v2: multi-page documents. A PDF becomes a parent record plus one child
    // per page, so every page carries its own status and extraction.
    const documents = tx.objectStore(STORES.documents);
    // IndexedDB skips records whose key path resolves to null, so roots
    // (parentId: null) are simply absent from these indexes — which makes
    // `index.getAll(parentId)` an exact child lookup with no sentinel value.
    documents.createIndex('parentId', 'parentId');
    documents.createIndex('parentPage', ['parentId', 'pageNumber']);

    // Backfill the new fields onto existing records. Cursor-based so it stays
    // inside the versionchange transaction and cannot half-apply.
    const cursorRequest = documents.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.update(migrateDocumentRecord(cursor.value));
      cursor.continue();
    };
  }
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new AppError(ERROR_CODES.STORAGE_ERROR, 'IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) =>
      upgrade(request.result, event.oldVersion, request.transaction);
    request.onsuccess = () => {
      const db = request.result;
      dbInstance = db;
      // If another tab upgrades or deletes the database, close so it can proceed.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        dbInstance = null;
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(toAppError(request.error, ERROR_CODES.STORAGE_ERROR));
    request.onblocked = () =>
      reject(new AppError(ERROR_CODES.STORAGE_ERROR, 'Database open was blocked by another tab'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Used by tests and "delete all data". Closes synchronously when possible. */
export function closeDatabase() {
  const p = dbPromise;
  dbPromise = null;
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  } else if (p) {
    p.then((db) => db.close()).catch(() => {});
  }
}

/**
 * Run `fn(tx)` inside a transaction over `storeNames`.
 * Resolves with fn's return value once the transaction completes.
 */
export async function withTransaction(storeNames, mode, fn) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(toAppError(err, ERROR_CODES.STORAGE_ERROR));
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(toAppError(tx.error, ERROR_CODES.STORAGE_ERROR));
    tx.onabort = () => reject(toAppError(tx.error, ERROR_CODES.STORAGE_ERROR));
    try {
      Promise.resolve(fn(tx)).then(
        (value) => {
          result = value;
        },
        (err) => {
          try {
            tx.abort();
          } catch {
            /* already aborted */
          }
          reject(toAppError(err, ERROR_CODES.STORAGE_ERROR));
        }
      );
    } catch (err) {
      reject(toAppError(err, ERROR_CODES.STORAGE_ERROR));
    }
  });
}

/** Promisify a single IDBRequest inside an open transaction. */
export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toAppError(request.error, ERROR_CODES.STORAGE_ERROR));
  });
}

/**
 * Delete the whole database (settings "delete all local data").
 * A blocked deletion must reject: reporting success while the data is still
 * present is worse than reporting the failure.
 */
export async function deleteDatabase() {
  closeDatabase();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    let blocked = false;
    request.onsuccess = () => resolve();
    request.onerror = () => reject(toAppError(request.error, ERROR_CODES.STORAGE_ERROR));
    request.onblocked = () => {
      blocked = true;
    };
    // `blocked` fires when another connection is open; the request stays
    // pending until that connection closes, so surface it rather than hang.
    setTimeout(() => {
      if (blocked) {
        reject(
          new AppError(
            ERROR_CODES.STORAGE_ERROR,
            'Deletion is blocked by another open tab of this app.',
            {
              hint: 'Close any other tabs running Simple OCR, then try again.',
            }
          )
        );
      }
    }, 3000);
  });
}
