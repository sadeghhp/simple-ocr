import { describe, expect, it, vi } from 'vitest';
import { AppError, ERROR_CODES } from '@/lib/errors';
import { createMutex, runPool } from '@/lib/pipeline/pool';
import {
  deriveParentError,
  deriveParentStatus,
  joinPageText,
  summarizePages,
} from '@/lib/pipeline/status';

const page = (status, extra = {}) => ({ status, pageNumber: 1, ...extra });

describe('deriveParentStatus', () => {
  it('is ready with no pages at all', () => {
    expect(deriveParentStatus([])).toBe('ready');
    expect(deriveParentStatus(null)).toBe('ready');
  });

  it('reports processing while any page is still running', () => {
    expect(deriveParentStatus([page('completed'), page('processing'), page('failed')])).toBe(
      'processing'
    );
  });

  it('is completed only when every page succeeded', () => {
    expect(deriveParentStatus([page('completed'), page('completed')])).toBe('completed');
    expect(deriveParentStatus([page('completed'), page('ready')])).toBe('partial');
  });

  it('is failed only when every page failed', () => {
    expect(deriveParentStatus([page('failed'), page('failed')])).toBe('failed');
  });

  it('is partial for any mix of succeeded and failed pages', () => {
    // 40 good pages and 2 bad ones is not a failed document, and calling it one
    // would hide 40 pages of usable text behind an error state.
    const pages = [...Array(40).fill(page('completed')), page('failed'), page('failed')];
    expect(deriveParentStatus(pages)).toBe('partial');
  });

  it('is ready when nothing has been attempted yet', () => {
    expect(deriveParentStatus([page('ready'), page('ready')])).toBe('ready');
  });

  it('summarizes page counts for progress display', () => {
    expect(summarizePages([page('completed'), page('failed'), page('processing')])).toEqual({
      total: 3,
      completed: 1,
      failed: 1,
      processing: 1,
    });
  });
});

describe('joinPageText', () => {
  it('joins pages in order with page markers, preferring edits', () => {
    const text = joinPageText([
      { pageNumber: 2, extractedText: 'second', editedText: 'second edited' },
      { pageNumber: 1, extractedText: 'first', editedText: null },
    ]);
    expect(text).toBe('--- Page 1 ---\nfirst\n\n--- Page 2 ---\nsecond edited');
  });

  it('skips pages that have no text yet', () => {
    const text = joinPageText([
      { pageNumber: 1, extractedText: 'done', editedText: null },
      { pageNumber: 2, extractedText: null, editedText: null },
    ]);
    expect(text).toBe('--- Page 1 ---\ndone');
  });
});

describe('runPool', () => {
  it('returns a result per item, in input order', async () => {
    const results = await runPool([1, 2, 3], async (n) => n * 2, { concurrency: 2 });
    expect(results.map((r) => r.value)).toEqual([2, 4, 6]);
    expect(results.every((r) => r.error === null)).toBe(true);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      },
      { concurrency: 3 }
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('sends one item at a time by default', async () => {
    // Serial by default: parallel bursts draw 429s, and a gateway behind bot
    // protection can answer a burst with a challenge carrying no CORS headers,
    // which the browser reports as an opaque network failure.
    let active = 0;
    let peak = 0;
    await runPool(
      [1, 2, 3, 4],
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 3));
        active -= 1;
      }
    );
    expect(peak).toBe(1);
  });

  it('isolates a failure so the remaining items still run', async () => {
    const worker = vi.fn(async (n) => {
      if (n === 2) throw new AppError(ERROR_CODES.PROVIDER_ERROR, 'page 2 exploded');
      return n;
    });
    const results = await runPool([1, 2, 3, 4], worker, { concurrency: 2 });

    expect(results[1].error.code).toBe('PROVIDER_ERROR');
    expect(results[1].value).toBeNull();
    expect(results.filter((r) => r.error === null).map((r) => r.value)).toEqual([1, 3, 4]);
  });

  it('retries a rate-limited item once and narrows the pool', async () => {
    const attempts = new Map();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const worker = vi.fn(async (n) => {
      const count = (attempts.get(n) ?? 0) + 1;
      attempts.set(n, count);
      if (n === 1 && count === 1) {
        throw new AppError(ERROR_CODES.RATE_LIMITED, 'slow down', { retryable: true });
      }
      return n;
    });

    const results = await runPool([1, 2, 3], worker, { concurrency: 3, sleep });

    expect(attempts.get(1)).toBe(2);
    expect(results[0].value).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry rather than looping on a persistent 429', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const worker = vi.fn(async () => {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'still limited', { retryable: true });
    });
    const results = await runPool([1], worker, { sleep });

    expect(worker).toHaveBeenCalledTimes(2);
    expect(results[0].error.code).toBe('RATE_LIMITED');
  });

  it('does not retry a non-retryable error', async () => {
    const sleep = vi.fn();
    const worker = vi.fn(async () => {
      throw new AppError(ERROR_CODES.AUTHENTICATION_FAILED, 'bad key');
    });
    await runPool([1], worker, { sleep });

    expect(worker).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops scheduling work once the signal is aborted', async () => {
    const controller = new AbortController();
    const worker = vi.fn(async (n) => {
      if (n === 0) controller.abort();
      return n;
    });
    const results = await runPool([0, 1, 2, 3], worker, { concurrency: 1, signal: controller.signal });

    expect(worker).toHaveBeenCalledTimes(1);
    // Every item still gets a result, so callers can tell cancelled from unseen.
    expect(results).toHaveLength(4);
    expect(results[3].error.code).toBe('PROCESSING_CANCELLED');
  });

  it('reports progress as items finish', async () => {
    const onProgress = vi.fn();
    await runPool([1, 2, 3], async (n) => n, { concurrency: 1, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[2][0]).toMatchObject({ done: 3, total: 3 });
  });

  it('handles an empty list', async () => {
    expect(await runPool([], async () => 1)).toEqual([]);
  });
});

describe('createMutex', () => {
  it('serializes tasks that would otherwise overlap', async () => {
    const runExclusive = createMutex();
    const order = [];
    let active = 0;
    let peak = 0;

    await Promise.all(
      [1, 2, 3].map((n) =>
        runExclusive(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          order.push(n);
          active -= 1;
        })
      )
    );

    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps running later tasks after one throws', async () => {
    const runExclusive = createMutex();
    const failed = runExclusive(async () => {
      throw new Error('render failed');
    });
    await expect(failed).rejects.toThrow('render failed');
    // One bad page must not deadlock every page behind it.
    await expect(runExclusive(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('deriveParentError', () => {
  const failedPage = (code, message, extra = {}) => ({
    status: 'failed',
    processingError: {
      code,
      message,
      detail: `detail for ${code}`,
      hint: `hint for ${code}`,
      retryable: true,
      createdAt: '2026-07-20T00:00:00.000Z',
      ...extra,
    },
  });

  it('returns null when nothing failed', () => {
    expect(deriveParentError([page('completed'), page('completed')])).toBeNull();
    expect(deriveParentError([])).toBeNull();
  });

  it('propagates the real cause when every page failed the same way', () => {
    // The reported bug: 10 of 10 pages blocked by CORS were reported as
    // "some pages could not be extracted", hiding the only useful information
    // and suggesting a retry that could not possibly work.
    const pages = Array.from({ length: 10 }, () =>
      failedPage('NETWORK_ERROR', 'Failed to fetch')
    );
    const error = deriveParentError(pages);

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('Every page failed');
    expect(error.message).toContain('Failed to fetch');
    expect(error.hint).toBe('hint for NETWORK_ERROR');
    expect(error.detail).toBe('detail for NETWORK_ERROR');
  });

  it('reports a partial failure when some pages succeeded', () => {
    const error = deriveParentError([
      page('completed'),
      page('completed'),
      failedPage('AUTHENTICATION_FAILED', 'bad key'),
    ]);
    expect(error.code).toBe('PAGE_PARTIAL_FAILURE');
    expect(error.message).toBe('1 of 3 pages failed');
    expect(error.hint).toContain('2 pages extracted');
  });

  it('falls back to the generic message when pages failed for different reasons', () => {
    const error = deriveParentError([
      failedPage('NETWORK_ERROR', 'Failed to fetch'),
      failedPage('RATE_LIMITED', 'slow down'),
    ]);
    expect(error.code).toBe('PAGE_PARTIAL_FAILURE');
    expect(error.hint).toContain('retry the pages that failed');
    // Both underlying reasons stay available in the details.
    expect(error.detail).toContain('NETWORK_ERROR');
    expect(error.detail).toContain('RATE_LIMITED');
  });

  it('still reports a failure when a page has no error record', () => {
    const error = deriveParentError([{ status: 'failed', processingError: null }]);
    expect(error.code).toBe('PAGE_PARTIAL_FAILURE');
  });
});
