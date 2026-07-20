// @vitest-environment node
// Node for the same reason as tests/multipage.test.js: a jsdom Blob does not
// survive fake-indexeddb's structured clone, and these tests store real files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, deleteDatabase } from '@/lib/db/database';
import { getDocument, listChildDocuments } from '@/lib/db/documents';
import { clearCache } from '@/lib/pdf/cache';
import { __setPdfjsLoader } from '@/lib/pdf/render';
import {
  processDocument,
  renameDocument,
  restoreOriginalName,
  saveProviderConfig,
  uploadFile,
} from '@/lib/workflows';
import { emptyProviderConfig } from '@/lib/providers/validation';

const validConfig = () => ({
  ...emptyProviderConfig(),
  name: 'Test',
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'test-model',
  apiKey: 'sk',
});

const pdfFile = (name = 'scan_0012.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });

const pngFile = (name = 'IMG_4471.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

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

/** A provider reply whose extraction carries `subject`. */
const replyWithSubject = (subject, rawText = 'page text') =>
  new Response(
    JSON.stringify({
      model: 'test-model-2024',
      choices: [
        {
          message: {
            content: JSON.stringify({
              documentType: 'invoice',
              subject,
              confidence: 0.9,
              language: 'en',
              fields: { invoiceNumber: 'INV-1', total: '10.00' },
              notes: null,
              rawText,
            }),
          },
          finish_reason: 'stop',
        },
      ],
    }),
    { status: 200 }
  );

// A fresh Response per call: a body can only be read once, so a shared one
// would make every request after the first fail.
const stubFetch = (subject) =>
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => replyWithSubject(subject)));

beforeEach(async () => {
  await deleteDatabase();
  clearCache();
  stubPdf(3);
  await saveProviderConfig(validConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('upload', () => {
  it('records the uploaded filename as the original name', async () => {
    const doc = await uploadFile(pngFile());
    expect(doc.name).toBe('IMG_4471.png');
    expect(doc.originalName).toBe('IMG_4471.png');
    expect(doc.nameLocked).toBe(false);
  });
});

describe('auto-rename on completion', () => {
  it('renames a single document to its extracted subject, keeping the original', async () => {
    stubFetch('Acme Corp Invoice 4471');
    const doc = await uploadFile(pngFile());

    await processDocument(doc.id);

    const updated = await getDocument(doc.id);
    // The extension carries over so the row still reads as a file.
    expect(updated.name).toBe('Acme Corp Invoice 4471.png');
    expect(updated.originalName).toBe('IMG_4471.png');
    // Auto-renaming is not a user choice, so it stays unlocked and re-runnable.
    expect(updated.nameLocked).toBe(false);
  });

  it('leaves the name alone when the model returns no subject', async () => {
    stubFetch(null);
    const doc = await uploadFile(pngFile());

    await processDocument(doc.id);

    const updated = await getDocument(doc.id);
    expect(updated.name).toBe('IMG_4471.png');
    expect(updated.status).toBe('completed');
  });

  it('names a multi-page document after its first page and re-derives the pages', async () => {
    stubFetch('Berlin Tenancy Agreement');
    const parent = await uploadFile(pdfFile());

    await processDocument(parent.id);

    const updated = await getDocument(parent.id);
    expect(updated.name).toBe('Berlin Tenancy Agreement.pdf');
    expect(updated.originalName).toBe('scan_0012.pdf');

    // A page's name always follows its parent's — otherwise the tree shows a
    // renamed parent above pages still carrying the scanner filename.
    const pages = await listChildDocuments(parent.id);
    expect(pages.every((p) => p.status === 'completed')).toBe(true);
    expect(pages.map((p) => p.name)).toEqual([
      'Berlin Tenancy Agreement.pdf — page 1',
      'Berlin Tenancy Agreement.pdf — page 2',
      'Berlin Tenancy Agreement.pdf — page 3',
    ]);
  });

  it('never renames a page after its own extraction', async () => {
    stubFetch('Berlin Tenancy Agreement');
    const parent = await uploadFile(pdfFile());
    const [page] = await listChildDocuments(parent.id);

    await processDocument(page.id);

    // The page took the parent's new name, not its own subject.
    const updated = await getDocument(page.id);
    expect(updated.name).toBe('Berlin Tenancy Agreement.pdf — page 1');
    expect(updated.extraction.subject).toBe('Berlin Tenancy Agreement');
  });
});

describe('manual rename', () => {
  it('renames, locks, and syncs child page names', async () => {
    stubFetch('Berlin Tenancy Agreement');
    const parent = await uploadFile(pdfFile());

    const updated = await renameDocument(parent.id, '  Lease 2026  ');

    expect(updated.name).toBe('Lease 2026');
    expect(updated.nameLocked).toBe(true);
    const pages = await listChildDocuments(parent.id);
    expect(pages.map((p) => p.name)).toEqual([
      'Lease 2026 — page 1',
      'Lease 2026 — page 2',
      'Lease 2026 — page 3',
    ]);
  });

  it('refuses an empty name rather than leaving an unnamed row', async () => {
    const doc = await uploadFile(pngFile());
    await expect(renameDocument(doc.id, '   ')).rejects.toMatchObject({
      code: 'INVALID_NAME',
    });
    expect((await getDocument(doc.id)).name).toBe('IMG_4471.png');
  });

  it('survives re-processing — a chosen name is never auto-renamed over', async () => {
    stubFetch('Acme Corp Invoice 4471');
    const doc = await uploadFile(pngFile());

    await renameDocument(doc.id, 'My Invoice.png');
    await processDocument(doc.id);

    expect((await getDocument(doc.id)).name).toBe('My Invoice.png');
  });
});

describe('restoring the original name', () => {
  it('puts the uploaded filename back and keeps it through a re-run', async () => {
    stubFetch('Acme Corp Invoice 4471');
    const doc = await uploadFile(pngFile());
    await processDocument(doc.id);
    expect((await getDocument(doc.id)).name).toBe('Acme Corp Invoice 4471.png');

    await restoreOriginalName(doc.id);
    expect((await getDocument(doc.id)).name).toBe('IMG_4471.png');

    // Restoring is a deliberate choice, so a later extraction must not undo it.
    await processDocument(doc.id);
    expect((await getDocument(doc.id)).name).toBe('IMG_4471.png');
  });

  it('restores a parent and re-derives its pages', async () => {
    stubFetch('Berlin Tenancy Agreement');
    const parent = await uploadFile(pdfFile());
    await processDocument(parent.id);

    await restoreOriginalName(parent.id);

    expect((await getDocument(parent.id)).name).toBe('scan_0012.pdf');
    const pages = await listChildDocuments(parent.id);
    expect(pages.map((p) => p.name)).toEqual([
      'scan_0012.pdf — page 1',
      'scan_0012.pdf — page 2',
      'scan_0012.pdf — page 3',
    ]);
  });
});
