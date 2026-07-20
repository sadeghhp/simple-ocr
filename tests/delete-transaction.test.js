// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

describe('deleteDocumentTree transaction safety', () => {
  /**
   * The bug this guards: awaiting a promise between IndexedDB requests hands
   * control back to the event loop, and the browser may commit the transaction
   * there — every later request then throws TransactionInactiveError. It
   * presented as "The browser database could not complete the operation" when
   * deleting a document.
   *
   * fake-indexeddb does not enforce transaction lifetime, so no functional test
   * against it can catch this. A harness that did model the rule confirmed the
   * await-based version failed, but was far too timing-sensitive to keep. This
   * checks the structural property instead: all requests must be issued from
   * IDB event handlers, never after an await.
   */
  it('issues its requests from event handlers, never across an await', () => {
    const source = readFileSync(resolve(__dirname, '../src/lib/db/documents.js'), 'utf8');
    const start = source.indexOf('export function deleteDocumentTree');
    expect(start).toBeGreaterThan(-1);
    const body = source
      .slice(start, source.indexOf('\n}', start))
      // Strip comments: the explanation of this very rule mentions `await`.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(body).not.toContain('await');
    expect(body).not.toContain('async');
    // Requests are chained through onsuccess instead.
    expect(body).toContain('onsuccess');
    expect(body).toContain('onerror');
  });
});

describe('deleteDocumentTree behaviour', () => {
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

  it('deletes a parent, its pages, and its blob', async () => {
    await seedParent(3);
    await deleteDocumentTree('parent-1');

    expect(await getDocument('parent-1')).toBeNull();
    expect(await listChildDocuments('parent-1')).toEqual([]);
    expect(await getFile('file-1')).toBeNull();
  });

  it('protects siblings and the shared blob when one page is deleted', async () => {
    await seedParent(3);
    await deleteDocumentTree('page-2');

    expect(await getFile('file-1')).not.toBeNull();
    expect(await getDocument('page-1')).not.toBeNull();
    expect(await getDocument('page-3')).not.toBeNull();
    expect(await getDocument('page-2')).toBeNull();
  });

  it('resolves quietly for an id that no longer exists', async () => {
    await expect(deleteDocumentTree('ghost')).resolves.toBeUndefined();
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
    expect(toAppError(domError, 'STORAGE_ERROR').detail).toBe('ConstraintError: Key already exists');
  });

  it('does not invent a detail for an ordinary error', () => {
    expect(toAppError(new Error('plain failure'), 'STORAGE_ERROR').detail).toBeNull();
  });
});
