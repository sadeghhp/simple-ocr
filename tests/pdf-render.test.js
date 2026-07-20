import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_EDGE_PX,
  MIN_EDGE_PX,
  PDF_BASE_DPI,
  TARGET_DPI,
  canvasSize,
  computeScale,
} from '@/lib/pdf/geometry';
import {
  MAX_ENTRIES,
  cacheKey,
  cacheStats,
  clearCache,
  getCached,
  invalidateFile,
  setCached,
} from '@/lib/pdf/cache';
import {
  __setPdfjsLoader,
  getPageCount,
  openDocument,
  renderPageCached,
} from '@/lib/pdf/render';

// A4 at 72 DPI, in PDF user-space units.
const A4 = { width: 595, height: 842 };

describe('computeScale', () => {
  it('targets the requested DPI when the result fits the pixel window', () => {
    // A4 at 150 DPI is 1240x1754 — inside [1000, 2000], so no clamping.
    const scale = computeScale(A4, TARGET_DPI);
    expect(scale).toBeCloseTo(TARGET_DPI / PDF_BASE_DPI, 5);
    expect(Math.round(A4.height * scale)).toBe(1754);
  });

  it('clamps a large page down to the maximum edge', () => {
    const poster = { width: 1684, height: 2384 }; // A1
    const scale = computeScale(poster, TARGET_DPI);
    expect(Math.max(poster.width, poster.height) * scale).toBeCloseTo(MAX_EDGE_PX, 5);
  });

  it('scales a small page up so its text still resolves', () => {
    const businessCard = { width: 243, height: 153 };
    const scale = computeScale(businessCard, TARGET_DPI);
    expect(Math.max(businessCard.width, businessCard.height) * scale).toBeCloseTo(MIN_EDGE_PX, 5);
  });

  it('respects an explicit DPI and survives degenerate input', () => {
    expect(computeScale(A4, 300)).toBeGreaterThan(computeScale(A4, 72));
    expect(computeScale({ width: 0, height: 0 })).toBe(1);
    expect(computeScale(null)).toBe(1);
  });

  it('produces integer canvas dimensions of at least one pixel', () => {
    expect(canvasSize({ width: 1239.6, height: 1753.2 })).toEqual({ width: 1239, height: 1753 });
    expect(canvasSize({ width: 0.2, height: 0.2 })).toEqual({ width: 1, height: 1 });
  });
});

describe('page cache', () => {
  const blob = (size) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

  beforeEach(() => clearCache());

  it('round-trips a rendered page and tracks bytes', () => {
    const key = cacheKey('file-1', 3, TARGET_DPI);
    setCached(key, blob(1024));
    expect(getCached(key).size).toBe(1024);
    expect(cacheStats()).toEqual({ size: 1, bytes: 1024 });
  });

  it('keys separately by file, page, and dpi', () => {
    setCached(cacheKey('f', 1, 150), blob(10));
    expect(getCached(cacheKey('f', 2, 150))).toBeNull();
    expect(getCached(cacheKey('f', 1, 300))).toBeNull();
    expect(getCached(cacheKey('g', 1, 150))).toBeNull();
  });

  it('evicts least-recently-used entries past the limit', () => {
    for (let i = 1; i <= MAX_ENTRIES; i += 1) setCached(cacheKey('f', i, 150), blob(10));
    // Touch page 1 so it is no longer the oldest.
    getCached(cacheKey('f', 1, 150));
    setCached(cacheKey('f', MAX_ENTRIES + 1, 150), blob(10));

    expect(cacheStats().size).toBe(MAX_ENTRIES);
    expect(getCached(cacheKey('f', 1, 150))).not.toBeNull();
    expect(getCached(cacheKey('f', 2, 150))).toBeNull();
  });

  it('drops every page of a file when its document is deleted', () => {
    setCached(cacheKey('doomed', 1, 150), blob(10));
    setCached(cacheKey('doomed', 2, 150), blob(10));
    setCached(cacheKey('keeper', 1, 150), blob(10));

    invalidateFile('doomed');
    expect(getCached(cacheKey('doomed', 1, 150))).toBeNull();
    expect(getCached(cacheKey('keeper', 1, 150))).not.toBeNull();
    expect(cacheStats().bytes).toBe(10);
  });
});

describe('render.js build safety', () => {
  it('never imports pdfjs-dist at the top level', () => {
    // A static import would be evaluated during `next build`'s Node prerender,
    // where Worker and canvas do not exist. This silently breaks the build
    // months later, so it is worth an explicit guard.
    const source = readFileSync(resolve(__dirname, '../src/lib/pdf/render.js'), 'utf8');
    const topLevelImports = source
      .split('\n')
      .filter((line) => /^import\s/.test(line))
      .join('\n');
    expect(topLevelImports).not.toContain('pdfjs-dist');
    expect(source).toContain("await import('pdfjs-dist/build/pdf.mjs')");
  });
});

describe('openDocument', () => {
  const pdfBlob = () => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
    type: 'application/pdf',
  });

  /** Minimal stand-in for pdfjs — the real library cannot run under Vitest. */
  function stubPdfjs({ numPages = 3, viewport = A4, renderImpl, getDocumentImpl } = {}) {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn();
    const render = renderImpl || vi.fn(() => ({ promise: Promise.resolve() }));

    const getPage = vi.fn(async () => ({
      getViewport: ({ scale }) => ({ width: viewport.width * scale, height: viewport.height * scale }),
      render,
      cleanup,
    }));

    const pdfjs = {
      GlobalWorkerOptions: { workerPort: {}, workerSrc: '' },
      getDocument:
        getDocumentImpl || vi.fn(() => ({ promise: Promise.resolve({ numPages, getPage, destroy }) })),
    };
    __setPdfjsLoader(async () => pdfjs);
    return { pdfjs, getPage, render, destroy, cleanup };
  }

  afterEach(() => {
    clearCache();
    vi.restoreAllMocks();
  });

  it('reports the page count and destroys the document', async () => {
    const { destroy } = stubPdfjs({ numPages: 12 });
    expect(await getPageCount(pdfBlob())).toBe(12);
    expect(destroy).toHaveBeenCalled();
  });

  it('renders a page to a JPEG blob at the computed scale', async () => {
    const { getPage, render, cleanup } = stubPdfjs();
    const doc = await openDocument(pdfBlob());
    const image = await doc.renderPage(2);

    expect(getPage).toHaveBeenCalledWith(2);
    expect(image.type).toBe('image/jpeg');
    expect(cleanup).toHaveBeenCalled();

    // The viewport handed to render must be the scaled one, not the unit one.
    const { viewport } = render.mock.calls[0][0];
    expect(Math.round(viewport.height)).toBe(1754);
    await doc.destroy();
  });

  it('fills the canvas white before drawing', async () => {
    const { render } = stubPdfjs();
    const doc = await openDocument(pdfBlob());
    await doc.renderPage(1);

    // Transparent PDFs composite onto black in JPEG without this.
    const { canvasContext } = render.mock.calls[0][0];
    expect(canvasContext.calls).toContainEqual(['fillStyle', '#ffffff']);
    const fill = canvasContext.calls.find(([name]) => name === 'fillRect');
    expect(fill.slice(1, 3)).toEqual([0, 0]);
    await doc.destroy();
  });

  it('rejects a page number outside the document', async () => {
    stubPdfjs({ numPages: 2 });
    const doc = await openDocument(pdfBlob());
    for (const bad of [0, 3, 1.5]) {
      await expect(doc.renderPage(bad)).rejects.toMatchObject({ code: 'PDF_RENDER_FAILED' });
    }
    await doc.destroy();
  });

  it('maps a password-protected PDF to PDF_ENCRYPTED', async () => {
    const err = Object.assign(new Error('No password given'), { name: 'PasswordException' });
    stubPdfjs({ getDocumentImpl: () => ({ promise: Promise.reject(err) }) });
    await expect(openDocument(pdfBlob())).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });
  });

  it('maps a page with no pages to PDF_NO_PAGES', async () => {
    stubPdfjs({ numPages: 0 });
    await expect(openDocument(pdfBlob())).rejects.toMatchObject({ code: 'PDF_NO_PAGES' });
  });

  it('maps a render failure to a retryable PDF_RENDER_FAILED naming the page', async () => {
    stubPdfjs({
      numPages: 10,
      renderImpl: () => ({ promise: Promise.reject(new Error('bad xref')) }),
    });
    const doc = await openDocument(pdfBlob());
    await expect(doc.renderPage(7)).rejects.toMatchObject({
      code: 'PDF_RENDER_FAILED',
      retryable: true,
    });
    // The page number must reach the user: "a page failed" is not actionable
    // when the document has 200 of them.
    await expect(doc.renderPage(7)).rejects.toThrow(/Page 7/);
    await doc.destroy();
  });

  it('aborts before doing any work when the signal is already aborted', async () => {
    const { pdfjs } = stubPdfjs();
    const controller = new AbortController();
    controller.abort();

    await expect(openDocument(pdfBlob(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'PROCESSING_CANCELLED',
    });
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });

  it('opens the document once and serves repeat pages from the cache', async () => {
    const { pdfjs } = stubPdfjs();
    const blob = pdfBlob();

    await renderPageCached('file-9', blob, 1);
    await renderPageCached('file-9', blob, 1);

    // The second call must not re-parse the PDF — that is the whole point of
    // caching, and re-parsing a large PDF per page is minutes of wasted work.
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });
});
