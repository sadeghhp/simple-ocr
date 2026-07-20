import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

/**
 * Canvas stubs for PDF rasterization.
 *
 * Neither test environment can rasterize: jsdom implements neither
 * `getContext('2d')` nor `toBlob`, and node has no canvas at all. Node is
 * nonetheless where the IndexedDB integration tests must run, because a jsdom
 * Blob does not survive fake-indexeddb's structured clone (`blob.arrayBuffer`
 * comes back undefined), so tests that store files need node's Blob.
 *
 * These stubs record calls rather than drawing. They verify the renderer sets
 * the canvas up correctly — size, white fill, JPEG encoding — and explicitly
 * not that the pixels are right. Pixel fidelity is pdf.js's job and is not
 * something a headless test can meaningfully assert.
 */
const noop = () => {};

function createRecordingContext(canvas) {
  const calls = [];
  return {
    calls,
    canvas,
    set fillStyle(value) {
      calls.push(['fillStyle', value]);
    },
    get fillStyle() {
      const last = [...calls].reverse().find(([key]) => key === 'fillStyle');
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
}

// Size is arbitrary but non-zero: the page cache's byte accounting reads it.
const stubImageBytes = () => new Uint8Array([0xff, 0xd8, 0xff]);

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  // render.js prefers OffscreenCanvas, so stubbing it covers both environments
  // with one implementation.
  globalThis.OffscreenCanvas = class OffscreenCanvasStub {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this._context = createRecordingContext(this);
    }

    getContext() {
      return this._context;
    }

    async convertToBlob({ type = 'image/png' } = {}) {
      return new Blob([stubImageBytes()], { type });
    }
  };
}

if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.toBlob) {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return createRecordingContext(this);
  };
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type = 'image/png') {
    callback(new Blob([stubImageBytes()], { type }));
  };
}
