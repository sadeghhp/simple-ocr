// @vitest-environment node
/**
 * Regressions for the Critical/High defects found in the 2026-07-21 review.
 * Each test fails against the code as it was written before that review.
 */
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@/lib/errors';
import { runPool } from '@/lib/pipeline/pool';
import { parseExtractionPayload, PARSE_WARNINGS } from '@/lib/extraction/parse';
import { validateManifest, restoreArchive, parseArchive } from '@/lib/export/importer';
import { EXPORT_VERSION } from '@/lib/export/exporter';
import { runOcr } from '@/lib/providers/adapter';

describe('parse: closing fence is anchored to the end of the reply', () => {
  it('keeps page text that itself contains a code fence', () => {
    const rawText = 'Install:\n```\nnpm i\n```\nDone. Signed by Alice.';
    const reply = '```json\n' + JSON.stringify({ documentType: 'generic', fields: {}, rawText }) + '\n```';

    const parsed = parseExtractionPayload(reply);

    // The unanchored regex cut at the first inner ``` and reported the *model*
    // as truncated, when in fact the parser had done the truncating.
    expect(parsed.data.rawText).toBe(rawText);
    expect(parsed.warnings).not.toContain(PARSE_WARNINGS.repairedTruncation);
  });
});

describe('runPool: one bad callback cannot strand the rest of the document', () => {
  it('completes every item when onProgress throws', async () => {
    const seen = [];
    const results = await runPool(
      [1, 2, 3],
      async (n) => {
        seen.push(n);
        return n * 2;
      },
      {
        concurrency: 1,
        onProgress: () => {
          throw new Error('a progress hook blew up');
        },
      }
    );

    expect(seen).toEqual([1, 2, 3]);
    expect(results.map((r) => r.value)).toEqual([2, 4, 6]);
  });

  it('records a result when the rate-limit backoff itself rejects', async () => {
    const rateLimited = Object.assign(new Error('slow down'), {
      code: ERROR_CODES.RATE_LIMITED,
    });

    const results = await runPool([1], async () => { throw rateLimited; }, {
      concurrency: 1,
      sleep: () => Promise.reject(new Error('backoff aborted')),
    });

    expect(results).toHaveLength(1);
    expect(results[0].error).toBe(rateLimited);
  });

});

describe('import: decompression is bounded by the manifest', () => {
  const manifestWith = (fileEntry) => ({
    exportVersion: EXPORT_VERSION,
    applicationVersion: '0.1.0',
    createdAt: 'x',
    documents: [],
    files: [fileEntry],
  });

  it('rejects a file entry with no declared size', () => {
    expect(() =>
      validateManifest(
        manifestWith({ id: 'f1', name: 'a.png', mimeType: 'image/png', createdAt: 'x' })
      )
    ).toThrow(/no valid size/);
  });

  it('rejects a file entry whose declared size exceeds the limit', () => {
    expect(() =>
      validateManifest(
        manifestWith({
          id: 'f1',
          name: 'a.png',
          mimeType: 'image/png',
          size: 21 * 1024 * 1024,
          createdAt: 'x',
        })
      )
    ).toThrow(/exceeds the maximum size/);
  });

  it('refuses an entry that inflates to more than the manifest declares', async () => {
    // A zip bomb in miniature: 1 MB of zeros compresses to a few hundred
    // bytes, while the manifest claims the file is 3 bytes.
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify(
        manifestWith({ id: 'f1', name: 'a.png', mimeType: 'image/png', size: 3, createdAt: 'x' })
      )
    );
    zip.folder('files').file('f1', new Uint8Array(1024 * 1024));
    const blob = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });

    const parsed = await parseArchive(blob);

    // The message distinguishes the two guards, and only one of them is real
    // protection: "larger than the manifest declares" is the pre-inflate
    // check. If this ever falls through to the post-inflate size comparison
    // ("does not match its declared size") the megabyte has already been
    // allocated and the bomb has gone off.
    await expect(restoreArchive(parsed)).rejects.toMatchObject({
      code: ERROR_CODES.IMPORT_INVALID,
      message: expect.stringMatching(/larger than the manifest declares/),
    });
  });
});

describe('adapter: a provider that never answers fails the page', () => {
  it('reports a timeout as a retryable network error, not a cancellation', async () => {
    const config = {
      endpoint: 'http://localhost:1234/v1',
      apiKey: 'k',
      model: 'm',
      supportsJsonMode: false,
    };
    // A fetch that settles only when aborted — the hung-provider case. The
    // optional chaining matters: without a deadline nothing ever aborts this,
    // so the call hangs rather than failing for some incidental reason.
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await expect(
      runOcr(blob, { mimeType: 'image/png', name: 'a.png' }, config, {
        fetchImpl,
        timeoutMs: 10,
      })
    ).rejects.toMatchObject({
      code: ERROR_CODES.NETWORK_ERROR,
      retryable: true,
      // Specifically the deadline, not any network failure that happens to
      // land on the same code.
      message: expect.stringMatching(/did not respond within/),
    });
  });

  it('classifies an abort that lands while reading the body', async () => {
    const config = {
      endpoint: 'http://localhost:1234/v1',
      apiKey: 'k',
      model: 'm',
      supportsJsonMode: false,
    };
    // Headers arrive, then the stream stalls and the deadline fires mid-read.
    // The raw DOMException used to escape unclassified; every caller of runOcr
    // expects an AppError with a code it can act on.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: () =>
        Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const err = await runOcr(blob, { mimeType: 'image/png', name: 'a.png' }, config, {
      fetchImpl,
      timeoutMs: 50000,
    }).catch((e) => e);

    expect(err.code).toBeDefined();
    expect(Object.values(ERROR_CODES)).toContain(err.code);
    expect(err.retryable).toBe(true);
  });

  it('still reports a user cancellation as a cancellation', async () => {
    const config = {
      endpoint: 'http://localhost:1234/v1',
      apiKey: 'k',
      model: 'm',
      supportsJsonMode: false,
    };
    const controller = new AbortController();
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
        controller.abort();
      });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await expect(
      runOcr(blob, { mimeType: 'image/png', name: 'a.png' }, config, {
        fetchImpl,
        signal: controller.signal,
        timeoutMs: 50000,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.PROCESSING_CANCELLED });
  });
});
