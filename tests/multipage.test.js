// @vitest-environment node
// Node, not jsdom: a jsdom Blob does not survive fake-indexeddb's structured
// clone, and these tests store real files. The canvas needed for rasterization
// is stubbed in tests/setup.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, deleteDatabase } from '@/lib/db/database';
import { getDocument, listChildDocuments, listRootDocuments } from '@/lib/db/documents';
import { getFile } from '@/lib/db/files';
import { clearCache } from '@/lib/pdf/cache';
import { __setPdfjsLoader } from '@/lib/pdf/render';
import {
  cancelProcessing,
  deleteDocument,
  loadProviderConfig,
  processDocument,
  reconcileInterruptedProcessing,
  saveProviderConfig,
  uploadFile,
} from '@/lib/workflows';
import { updateDocument } from '@/lib/db/documents';
import { emptyProviderConfig } from '@/lib/providers/validation';

const validConfig = () => ({
  ...emptyProviderConfig(),
  name: 'Test',
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'test-model',
  apiKey: 'sk',
});

const pdfFile = (name = 'multi.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });

const pngFile = (name = 'scan.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

/** Stand in for pdfjs so uploads and renders work without the real library. */
function stubPdf(numPages) {
  __setPdfjsLoader(async () => ({
    GlobalWorkerOptions: { workerPort: {}, workerSrc: '' },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages,
        getPage: async () => ({
          getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => {},
        }),
        destroy: async () => {},
      }),
    }),
  }));
}

/** A provider reply carrying a structured extraction for one page. */
const extractionReply = (pageText, documentType = 'invoice') =>
  new Response(
    JSON.stringify({
      model: 'test-model-2024',
      choices: [
        {
          message: {
            content: JSON.stringify({
              documentType,
              confidence: 0.9,
              language: 'en',
              fields: { invoiceNumber: 'INV-1', total: '10.00' },
              notes: null,
              rawText: pageText,
            }),
          },
          finish_reason: 'stop',
        },
      ],
    }),
    { status: 200 }
  );

beforeEach(async () => {
  await deleteDatabase();
  clearCache();
  stubPdf(3);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('multi-page upload', () => {
  it('creates a parent plus one page record per page', async () => {
    const parent = await uploadFile(pdfFile());

    expect(parent.kind).toBe('parent');
    expect(parent.pageCount).toBe(3);

    const pages = await listChildDocuments(parent.id);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // Pages are metadata only at upload time — nothing is rasterized yet.
    expect(pages.every((p) => p.extractedText === null)).toBe(true);
    expect(pages.every((p) => p.ownsFile === false)).toBe(true);

    // The sidebar shows one entry, not four.
    expect(await listRootDocuments()).toHaveLength(1);
  });

  it('falls back to a single document when the PDF cannot be read', async () => {
    __setPdfjsLoader(async () => {
      throw new Error('corrupt xref table');
    });
    const doc = await uploadFile(pdfFile('broken.pdf'));

    // An unreadable PDF is still uploaded and still processable as a whole
    // file — rejecting it would strand a document the provider might handle.
    expect(doc.kind).toBe('single');
    expect(doc.pageCount).toBeNull();
    expect(await listChildDocuments(doc.id)).toEqual([]);
  });

  it('leaves a plain image as a single document', async () => {
    const doc = await uploadFile(pngFile());
    expect(doc.kind).toBe('single');
    expect(await listChildDocuments(doc.id)).toEqual([]);
  });

  it('rejects a PDF beyond the page limit', async () => {
    stubPdf(500);
    await expect(uploadFile(pdfFile('huge.pdf'))).rejects.toMatchObject({
      code: 'PDF_TOO_MANY_PAGES',
    });
  });
});

describe('processing a multi-page document', () => {
  it('extracts every page and completes the parent', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call += 1;
        return extractionReply(`text of page ${call}`);
      })
    );

    const updated = await processDocument(parent.id);
    expect(updated.status).toBe('completed');

    const pages = await listChildDocuments(parent.id);
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      expect(p.status).toBe('completed');
      expect(p.documentType).toBe('invoice');
      expect(p.extraction.fields.invoiceNumber).toBe('INV-1');
      expect(p.extractedText).toMatch(/text of page/);
    }

    // The parent's text is its pages joined with markers, so document-level
    // copy and export keep working unchanged.
    expect(updated.extractedText).toContain('--- Page 1 ---');
    expect(updated.extractedText).toContain('--- Page 3 ---');
    expect(await getFile(parent.fileId)).not.toBeNull();
  });

  it('marks the parent partial when only some pages fail', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 2) return new Response('nope', { status: 401 });
        return extractionReply(`page ${call}`);
      })
    );

    const updated = await processDocument(parent.id);

    expect(updated.status).toBe('partial');
    expect(updated.processingError.code).toBe('PAGE_PARTIAL_FAILURE');

    const pages = await listChildDocuments(parent.id);
    expect(pages.filter((p) => p.status === 'completed')).toHaveLength(2);
    const failed = pages.find((p) => p.status === 'failed');
    expect(failed.processingError.code).toBe('AUTHENTICATION_FAILED');
    // The successful pages keep their text — one bad page loses only itself.
    expect(updated.extractedText).toContain('--- Page 1 ---');
  });

  it('surfaces the real cause when every page fails the same way', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    // Every page blocked identically — the shape of a CORS rejection or a bad
    // key. The document must report that reason, not a vague page failure.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const updated = await processDocument(parent.id);

    expect(updated.status).toBe('failed');
    expect(updated.processingError.code).toBe('NETWORK_ERROR');
    expect(updated.processingError.message).toContain('Every page failed');
    // The actionable guidance from the underlying error must survive.
    expect(updated.processingError.hint).toMatch(/CORS|connection/i);
  });

  it('retries a single failed page without touching its siblings', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 2) return new Response('nope', { status: 401 });
        return extractionReply(`page ${call}`);
      })
    );
    await processDocument(parent.id);

    const failed = (await listChildDocuments(parent.id)).find((p) => p.status === 'failed');
    const siblingsBefore = (await listChildDocuments(parent.id))
      .filter((p) => p.id !== failed.id)
      .map((p) => p.extractedText);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(extractionReply('recovered page')));
    await processDocument(failed.id);

    const after = await listChildDocuments(parent.id);
    expect(after.find((p) => p.id === failed.id).extractedText).toBe('recovered page');
    expect(after.filter((p) => p.id !== failed.id).map((p) => p.extractedText)).toEqual(
      siblingsBefore
    );

    // The parent re-derives to completed now that every page has text.
    expect((await getDocument(parent.id)).status).toBe('completed');
  });

  it('refuses a page retry while its parent is mid-run', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    // Several pages are in flight at once, so every pending request needs
    // releasing or the run never settles.
    const releases = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve(extractionReply('page')));
          })
      )
    );

    const run = processDocument(parent.id);
    await new Promise((r) => setTimeout(r, 20));

    const page = (await listChildDocuments(parent.id))[0];
    await expect(processDocument(page.id)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSING',
    });

    while (releases.length > 0) {
      releases.shift()();
      await new Promise((r) => setTimeout(r, 5));
    }
    await run;
  });

  it('keeps a page that returned unparseable JSON as completed text', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    // A fresh Response per call: a body can only be read once, so reusing one
    // instance across pages fails every page after the first.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'Just the plain text, no JSON.' } }] }),
            { status: 200 }
          )
      )
    );

    const updated = await processDocument(parent.id);
    expect(updated.status).toBe('completed');

    const pages = await listChildDocuments(parent.id);
    for (const p of pages) {
      // Text survives; only the structure is missing. Failing here would hide
      // a perfectly good page of OCR behind an error.
      expect(p.status).toBe('completed');
      expect(p.extractedText).toBe('Just the plain text, no JSON.');
      expect(p.extraction.degraded).toBe(true);
      expect(p.extractionWarnings).toContain('EXTRACTION_NOT_JSON');
    }
  });
});

describe('json mode downgrade', () => {
  it('retries without response_format and remembers the rejection', async () => {
    await saveProviderConfig(validConfig());
    const doc = await uploadFile(pngFile());

    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url, init) => {
        calls.push(JSON.parse(init.body));
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({ error: { message: 'response_format is not supported' } }),
            { status: 400 }
          );
        }
        return extractionReply('recovered without json mode');
      })
    );

    const updated = await processDocument(doc.id);

    expect(updated.status).toBe('completed');
    expect(calls[0].response_format).toEqual({ type: 'json_object' });
    expect(calls[1].response_format).toBeUndefined();

    // Remembered, so the wasted request costs one per provider, not one per page.
    expect((await loadProviderConfig()).supportsJsonMode).toBe(false);
  });
});

describe('cancellation', () => {
  it('returns cancelled pages to ready rather than failed', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (url, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
      )
    );

    const run = processDocument(parent.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelProcessing(parent.id)).toBe(true);
    await run;

    const pages = await listChildDocuments(parent.id);
    // Cancelling is a user action, not a failure — no error banner, still retryable.
    expect(pages.every((p) => p.status === 'ready')).toBe(true);
    expect(pages.every((p) => p.processingError === null)).toBe(true);
  });
});

describe('interrupted recovery for pages', () => {
  it('recovers stuck pages and re-derives the parent', async () => {
    await saveProviderConfig(validConfig());
    const parent = await uploadFile(pdfFile());
    const pages = await listChildDocuments(parent.id);

    // Simulate a tab that died with page 1 mid-request and page 2 already done.
    await updateDocument(pages[0].id, { status: 'processing' });
    await updateDocument(pages[1].id, { status: 'completed', extractedText: 'page 2 text' });
    await updateDocument(parent.id, { status: 'processing' });

    const recovered = await reconcileInterruptedProcessing();
    expect(recovered).toBe(2); // the stuck page and the stuck parent

    const after = await listChildDocuments(parent.id);
    expect(after[0].status).toBe('failed');
    expect(after[0].processingError.code).toBe('PROCESSING_INTERRUPTED');

    // The parent is derived, never stamped by hand: one failed, one completed,
    // one untouched makes it partial rather than failed.
    expect((await getDocument(parent.id)).status).toBe('partial');
  });
});

describe('deleting a multi-page document', () => {
  it('removes the parent, every page, and the shared blob', async () => {
    const parent = await uploadFile(pdfFile());
    await deleteDocument(parent.id);

    expect(await getDocument(parent.id)).toBeNull();
    expect(await listChildDocuments(parent.id)).toEqual([]);
    expect(await getFile(parent.fileId)).toBeNull();
    expect(await listRootDocuments()).toEqual([]);
  });
});
