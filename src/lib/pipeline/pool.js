/**
 * Bounded-concurrency worker pool for page processing.
 *
 * The limiter here is the provider, not the CPU. Pages are sent one at a time
 * by default: a burst of parallel requests collects 429s on most accounts, and
 * gateways behind bot protection (OpenRouter sits behind Cloudflare) can answer
 * a burst with a challenge page that carries no CORS headers — which the
 * browser reports as an opaque network failure rather than a rate limit.
 * Serial is slower and far more predictable, and a page that does hit a limit
 * still narrows the pool and retries.
 */
import { ERROR_CODES } from '@/lib/errors';

export const DEFAULT_CONCURRENCY = 1;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serializes access to a shared non-reentrant resource.
 * Rasterization needs this: pdf.js has a single worker, and rendering several
 * 2000px canvases at once is where memory spikes come from — even though the
 * network calls that follow should still overlap.
 */
export function createMutex() {
  let tail = Promise.resolve();
  return function runExclusive(fn) {
    const result = tail.then(fn, fn);
    // Swallow rejection on the chain itself so one failure cannot poison the
    // queue for every task behind it.
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

function isRateLimited(error) {
  return error?.code === ERROR_CODES.RATE_LIMITED;
}

function isCancelled(error) {
  return error?.code === ERROR_CODES.PROCESSING_CANCELLED;
}

/**
 * Run `worker(item, index)` over `items` with at most `concurrency` in flight.
 *
 * Never rejects: each result is `{ item, index, value, error }` so one bad page
 * cannot abandon the rest of the document.
 *
 * @param {Array} items
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {done: number, total: number, item: any}) => void} [options.onProgress]
 * @param {(ms: number) => Promise<void>} [options.sleep] injected for tests
 * @param {number} [options.rateLimitBackoffMs]
 */
export async function runPool(
  items,
  worker,
  {
    concurrency = DEFAULT_CONCURRENCY,
    signal = null,
    onProgress = null,
    sleep = defaultSleep,
    rateLimitBackoffMs = 2000,
  } = {}
) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  if (list.length === 0) return results;

  // Shared across runners so a 429 narrows the whole pool, not one lane.
  let activeLimit = Math.max(1, Math.min(concurrency, list.length));
  let next = 0;
  let done = 0;
  let running = 0;

  async function attempt(item, index, isRetry) {
    try {
      return { item, index, value: await worker(item, index), error: null };
    } catch (error) {
      // Only the first attempt narrows: letting the retry narrow again lets a
      // single page quarter the pool for every page still queued behind it.
      if (isRateLimited(error) && !isRetry) {
        // Narrow for everything still queued, then give this page one more go.
        activeLimit = Math.max(1, Math.floor(activeLimit / 2));
        if (!signal?.aborted) {
          // `sleep` is injectable, so it is not assumed to resolve. A rejecting
          // backoff must still produce a result record, or the pool stalls.
          try {
            await sleep(rateLimitBackoffMs);
          } catch {
            return { item, index, value: null, error };
          }
          if (!signal?.aborted) return attempt(item, index, true);
        }
      }
      return { item, index, value: null, error };
    }
  }

  await new Promise((resolve) => {
    const pump = () => {
      if (next >= list.length && running === 0) {
        resolve();
        return;
      }
      while (running < activeLimit && next < list.length) {
        const index = next;
        next += 1;
        running += 1;

        // A cancelled run still records a result per item, so the caller can
        // tell "cancelled before it started" from "never scheduled".
        const task = signal?.aborted
          ? Promise.resolve({
              item: list[index],
              index,
              value: null,
              error: Object.assign(new Error('Cancelled'), {
                code: ERROR_CODES.PROCESSING_CANCELLED,
              }),
            })
          : attempt(list[index], index, false);

        // Bookkeeping runs on both settle paths. `attempt` is written not to
        // reject, but a rejection here would decrement nothing and leave the
        // outer promise pending forever — the pool would hang with no error.
        const settle = (result) => {
          results[index] = result;
          running -= 1;
          done += 1;
          try {
            if (onProgress && !isCancelled(result.error)) {
              onProgress({ done, total: list.length, item: result.item });
            }
          } catch {
            // A throwing progress callback is the caller's problem, not a
            // reason to abandon every page still queued.
          } finally {
            pump();
          }
        };

        task.then(settle, (error) =>
          settle({ item: list[index], index, value: null, error })
        );
      }
    };
    pump();
  });

  return results;
}
