import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

/**
 * jsdom implements neither `getContext('2d')` nor `toBlob`, so anything that
 * rasterizes a PDF page throws "Not implemented" without these.
 *
 * These stubs record calls rather than drawing: they verify that the renderer
 * sets up the canvas correctly (size, white fill, JPEG encoding) — never that
 * the pixels are right. Pixel fidelity is pdf.js's job and is not something a
 * headless test can meaningfully assert.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  const noop = () => {};
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const calls = [];
    return {
      calls,
      canvas: this,
      set fillStyle(value) {
        calls.push(['fillStyle', value]);
      },
      get fillStyle() {
        const last = [...calls].reverse().find(([k]) => k === 'fillStyle');
        return last ? last[1] : '#000000';
      },
      fillRect: (...args) => calls.push(['fillRect', ...args]),
      drawImage: noop,
      save: noop,
      restore: noop,
      scale: noop,
      translate: noop,
      transform: noop,
      setTransform: noop,
      clearRect: noop,
      beginPath: noop,
      closePath: noop,
      clip: noop,
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: noop,
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
  };

  HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type = 'image/png') {
    // Size is arbitrary but non-zero: the cache's byte accounting depends on it.
    callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type }));
  };
}
