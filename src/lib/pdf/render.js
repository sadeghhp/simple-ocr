/**
 * Client-side PDF page rasterization.
 *
 * IMPORTANT: this module must never import pdfjs-dist at the top level.
 * `output: 'export'` prerenders every page in Node at build time, where
 * `Worker`, `DOMMatrix` and `canvas` do not exist — a static import would break
 * `next build`. The dynamic import below means the module graph is only entered
 * on a real user action in a browser. `tests/pdf-render.test.js` guards this.
 */
import { AppError, ERROR_CODES } from '@/lib/errors';
import {
  IMAGE_MIME,
  IMAGE_QUALITY,
  TARGET_DPI,
  canvasSize,
  computeScale,
} from '@/lib/pdf/geometry';
import { cacheKey, getCached, setCached } from '@/lib/pdf/cache';

/** Beyond this a single upload fans out into an unreasonable number of requests. */
export const MAX_PDF_PAGES = 200;

let loader = async () => {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  // `new Worker(new URL(...))` is the only form that survives a static export:
  // webpack and Turbopack both recognise it statically and emit the worker as a
  // local hashed asset. A string workerSrc resolves at runtime against the page
  // URL instead, which is the classic "Setting up fake worker failed".
  if (!pdfjs.GlobalWorkerOptions.workerPort && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
      { type: 'module' }
    );
  }
  return pdfjs;
};

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = loader().catch((err) => {
      pdfjsPromise = null; // let a later attempt retry rather than caching failure
      throw err;
    });
  }
  return pdfjsPromise;
}

/** Test seam: swap the pdfjs loader, since the real one cannot run under Vitest. */
export function __setPdfjsLoader(fn) {
  loader = fn;
  pdfjsPromise = null;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AppError(ERROR_CODES.PROCESSING_CANCELLED, 'Rendering was cancelled', {
      retryable: true,
    });
  }
}

function normalizePdfError(err, pageNumber = null) {
  if (err instanceof AppError) return err;
  const name = err?.name || '';
  const message = err?.message || String(err);

  if (name === 'PasswordException' || /password/i.test(message)) {
    return new AppError(ERROR_CODES.PDF_ENCRYPTED, message, { cause: err });
  }
  if (name === 'AbortException') {
    return new AppError(ERROR_CODES.PROCESSING_CANCELLED, message, { cause: err, retryable: true });
  }
  return new AppError(
    ERROR_CODES.PDF_RENDER_FAILED,
    pageNumber ? `Page ${pageNumber}: ${message}` : message,
    { cause: err, retryable: true, detail: message }
  );
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: IMAGE_MIME, quality: IMAGE_QUALITY });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new AppError(ERROR_CODES.PDF_RENDER_FAILED, 'Canvas produced no image')),
      IMAGE_MIME,
      IMAGE_QUALITY
    );
  });
}

/** Safari does not release canvas backing stores promptly; a long loop will OOM. */
function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* OffscreenCanvas in some engines disallows this — not worth failing over */
  }
}

/**
 * Open a PDF once and render pages from it.
 *
 * The pipeline opens a document per parent rather than per page: re-parsing a
 * 20 MB PDF for each of 100 pages is the difference between seconds and
 * minutes. Callers MUST `destroy()` when done.
 *
 * @returns {Promise<{ pageCount: number, renderPage: Function, destroy: Function }>}
 */
export async function openDocument(blob, { signal } = {}) {
  throwIfAborted(signal);
  let pdfjs;
  let doc;
  try {
    pdfjs = await loadPdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    throwIfAborted(signal);
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    throw normalizePdfError(err);
  }

  const pageCount = doc.numPages;
  if (!pageCount || pageCount < 1) {
    await doc.destroy?.();
    throw new AppError(ERROR_CODES.PDF_NO_PAGES, 'PDF contains no pages');
  }

  return {
    pageCount,

    async renderPage(pageNumber, { dpi = TARGET_DPI } = {}) {
      throwIfAborted(signal);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
        throw new AppError(
          ERROR_CODES.PDF_RENDER_FAILED,
          `Page ${pageNumber} is out of range (1-${pageCount})`
        );
      }

      let canvas;
      try {
        const page = await doc.getPage(pageNumber);
        const scale = computeScale(page.getViewport({ scale: 1 }), dpi);
        const viewport = page.getViewport({ scale });
        const { width, height } = canvasSize(viewport);

        canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        // PDFs with transparent backgrounds composite onto black in JPEG.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);

        await page.render({ canvasContext: context, viewport }).promise;
        throwIfAborted(signal);

        const rendered = await canvasToBlob(canvas);
        page.cleanup?.();
        return rendered;
      } catch (err) {
        throw normalizePdfError(err, pageNumber);
      } finally {
        if (canvas) releaseCanvas(canvas);
      }
    },

    async destroy() {
      try {
        await doc.destroy?.();
      } catch {
        /* already torn down */
      }
    },
  };
}

/** Page count only. Opens and closes the document — use `openDocument` in a loop. */
export async function getPageCount(blob) {
  const doc = await openDocument(blob);
  try {
    return doc.pageCount;
  } finally {
    await doc.destroy();
  }
}

/**
 * Render one page, reusing the shared cache.
 * `fileId` scopes the cache entry so a deleted document can invalidate its pages.
 */
export async function renderPageCached(fileId, blob, pageNumber, { dpi = TARGET_DPI, signal } = {}) {
  const key = cacheKey(fileId, pageNumber, dpi);
  const hit = getCached(key);
  if (hit) return hit;

  const doc = await openDocument(blob, { signal });
  try {
    return setCached(key, await doc.renderPage(pageNumber, { dpi }));
  } finally {
    await doc.destroy();
  }
}
