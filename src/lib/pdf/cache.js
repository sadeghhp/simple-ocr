/**
 * In-memory LRU of rendered page images, shared by the preview pane and the
 * OCR pipeline.
 *
 * Deliberately NOT persisted to IndexedDB: page rasters for a large PDF run to
 * tens of megabytes on top of an original we never discard, and quota
 * exhaustion is the failure mode that actually breaks a browser-only app.
 * pdf.js rebuilds a page in a couple of hundred milliseconds, so this only
 * needs to cover the cases that matter — an immediate retry, and flipping back
 * and forth between pages in the preview.
 */

export const MAX_ENTRIES = 8;
export const MAX_BYTES = 64 * 1024 * 1024;

// Map preserves insertion order, which is all an LRU needs.
const entries = new Map();
let totalBytes = 0;

export function cacheKey(fileId, pageNumber, dpi) {
  return `${fileId}:${pageNumber}:${dpi}`;
}

function evictUntilWithinLimits() {
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    const evicted = entries.get(oldest.value);
    entries.delete(oldest.value);
    totalBytes -= evicted?.size ?? 0;
  }
}

/** Most-recently-used wins: re-reading refreshes an entry's position. */
export function getCached(key) {
  const hit = entries.get(key);
  if (!hit) return null;
  entries.delete(key);
  entries.set(key, hit);
  return hit.blob;
}

export function setCached(key, blob) {
  const existing = entries.get(key);
  if (existing) {
    entries.delete(key);
    totalBytes -= existing.size;
  }
  entries.set(key, { blob, size: blob?.size ?? 0 });
  totalBytes += blob?.size ?? 0;
  evictUntilWithinLimits();
  return blob;
}

/** Drop every page of one file — used when its document is deleted. */
export function invalidateFile(fileId) {
  const prefix = `${fileId}:`;
  for (const [key, value] of entries) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
      totalBytes -= value.size;
    }
  }
}

export function clearCache() {
  entries.clear();
  totalBytes = 0;
}

export function cacheStats() {
  return { size: entries.size, bytes: totalBytes };
}
