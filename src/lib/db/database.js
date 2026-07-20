/**
 * Central IndexedDB access. All database transactions in the app go through
 * this module — UI code must never open its own (spec §6.3, §27).
 */
import { AppError, ERROR_CODES, toAppError } from '@/lib/errors';
import { SCHEMA_VERSION, migrateDocumentRecord } from '@/lib/db/migrations';

export const DB_NAME = 'simple-ocr';
// v4 carries record schema v3 (originalName / nameLocked). Record migration
// only runs during a versionchange transaction, so a record-shape change always
// needs a database bump to have somewhere to happen. Database version and
// record version still move independently — v3 was an index repair with no
// record change at all.
export const DB_VERSION = 4;
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

/** Create an index only when it is absent, so a migration can safely re-run. */
function ensureIndex(store, name, keyPath) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath);
}

/**
 * Indexes the current code depends on. Applied by every migration from v2
 * onward rather than only when introduced: a database was observed in the wild
 * at version 2 with these missing, which made every child lookup throw
 * NotFoundError. Re-asserting them is cheap and repairs that state.
 */
function ensureDocumentIndexes(documents) {
  // IndexedDB skips records whose key path resolves to null, so roots
  // (parentId: null) are simply absent from these indexes — which makes
  // `index.getAll(parentId)` an exact child lookup with no sentinel value.
  ensureIndex(documents, 'parentId', 'parentId');
  ensureIndex(documents, 'parentPage', ['parentId', 'pageNumber']);
}

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
    ensureDocumentIndexes(documents);

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

  if (oldVersion < 3) {
    // v3 adds no fields. It exists purely to repair databases that reached v2
    // without the indexes — without a version bump there is no opportunity to
    // create them, since createIndex is only legal during an upgrade.
    ensureDocumentIndexes(tx.objectStore(STORES.documents));
  }

  if (oldVersion < 4) {
    // v4: record schema v3 adds `originalName`, backfilled from the current
    // name — an existing document has never been renamed, so its name is its
    // original. Without this backfill an older document could be auto-renamed
    // with no way back to the filename the user knows it by.
    const documents = tx.objectStore(STORES.documents);
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
