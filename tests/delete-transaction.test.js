// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, deleteDatabase } from '@/lib/db/database';
import {
  DOCUMENT_KIND,
  createDocumentRecord,
  createPageRecord,
  deleteDocumentTree,
  getDocument,
  listChildDocuments,
  putDocument,
} from '@/lib/db/documents';
import { createFileRecord, getFile, putFile } from '@/lib/db/files';
import { toAppError } from '@/lib/errors';

beforeEach(async () => {
  await deleteDatabase();
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

async function seedParent(pageCount = 3) {
  await putFile(
    createFileRecord({
      id: 'file-1',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
      name: 'multi.pdf',
      mimeType: 'application/pdf',
      size: 3,
    })
  );
  const parent = createDocumentRecord({
    id: 'parent-1',
    fileId: 'file-1',
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

/**
 * Real browsers commit a readwrite transaction as soon as control returns to
 * the event loop with no pending requests — after which further requests throw
 * TransactionInactiveError. fake-indexeddb does not enforce this, so this stub
 * adds the missing rule: any request issued after a macrotask boundary fails.
 *
 * This is what makes the difference between "passes in tests" and "fails when
 * you click delete" observable here.
 */
function enforceTransactionLifetime() {
  const originalTransaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (...args) {
    const tx = originalTransaction.apply(this, args);
    let active = true;
    // Deactivate once the current task (and its microtasks) has drained.
    setTimeout(() => {
      active = false;
    }, 0);

    // Plain `target[prop]` rather than Reflect.get with the proxy as receiver:
    // fake-indexeddb's getters read internal state, and handing them the proxy
    // instead of the real object breaks them.
    const wrapStore = (store) =>
      new Proxy(store, {
        get(target, prop) {
          const value = target[prop];
          if (typeof value !== 'function') return value;
          return (...callArgs) => {
            if (!active) {
              throw Object.assign(
                new Error('Failed to execute on IDBObjectStore: The transaction is inactive.'),
                { name: 'TransactionInactiveError' }
              );
            }
            const result = value.apply(target, callArgs);
            // Indexes issue requests too, and must obey the same rule.
            return prop === 'index' ? wrapStore(result) : result;
          };
        },
      });

    return new Proxy(tx, {
      get(target, prop) {
        if (prop === 'objectStore') {
          return (name) => wrapStore(target.objectStore(name));
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        // Handlers like tx.oncomplete must land on the real transaction.
        target[prop] = value;
        return true;
      },
    });
  });
}

describe('deleteDocumentTree under real-browser transaction rules', () => {
  it('deletes a multi-page document without the transaction going inactive', async () => {
    const parent = await seedParent(3);
    enforceTransactionLifetime();

    await deleteDocumentTree(parent.id);

    expect(await getDocument('parent-1')).toBeNull();
    expect(await listChildDocuments('parent-1')).toEqual([]);
    expect(await getFile('file-1')).toBeNull();
  });

  it('deletes a single-file document under the same rules', async () => {
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
    enforceTransactionLifetime();

    await deleteDocumentTree('solo');
    expect(await getDocument('solo')).toBeNull();
    expect(await getFile('file-solo')).toBeNull();
  });

  it('still protects siblings when one page is deleted', async () => {
    await seedParent(3);
    enforceTransactionLifetime();

    await deleteDocumentTree('page-2');
    expect(await getFile('file-1')).not.toBeNull();
    expect(await getDocument('page-1')).not.toBeNull();
    expect(await getDocument('page-2')).toBeNull();
  });
});

describe('storage error reporting', () => {
  it('keeps the DOMException name so a storage failure can be diagnosed', () => {
    // Several browsers leave DOMException.message empty; without the name a
    // failed delete reports nothing the user or a maintainer can act on.
    const domError = Object.assign(new Error(''), { name: 'TransactionInactiveError' });
    const appError = toAppError(domError, 'STORAGE_ERROR');

    expect(appError.code).toBe('STORAGE_ERROR');
    expect(appError.detail).toContain('TransactionInactiveError');
  });

  it('includes both name and message when the browser supplies one', () => {
    const domError = Object.assign(new Error('Key already exists'), { name: 'ConstraintError' });
    expect(toAppError(domError, 'STORAGE_ERROR').detail).toBe(
      'ConstraintError: Key already exists'
    );
  });
});
