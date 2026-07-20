/**
 * Page rasterization geometry. Pure and dependency-free so the resolution
 * decisions — the ones that actually determine OCR accuracy — are testable
 * without a browser or a PDF.
 */

/** PDF user space is 72 units per inch; a pdf.js viewport at scale 1 is 72 DPI. */
export const PDF_BASE_DPI = 72;

/**
 * 150 DPI is the floor at which small print and stamped serial numbers stay
 * legible to a vision model. 300 DPI doubles the pixels for accuracy gains that
 * disappear once the provider downscales server-side.
 */
export const TARGET_DPI = 150;

/**
 * Below ~1000 px on the long edge, body text stops resolving. Above ~2000 px,
 * every provider downscales anyway, so the extra pixels only cost encode time
 * and upload bytes.
 */
export const MIN_EDGE_PX = 1000;
export const MAX_EDGE_PX = 2000;

/** JPEG rather than PNG: ~7x smaller for scanned text, and base64 adds 33% on top. */
export const IMAGE_MIME = 'image/jpeg';
export const IMAGE_QUALITY = 0.85;

/**
 * Scale factor to apply to a pdf.js viewport taken at scale 1.
 *
 * @param {{ width: number, height: number }} viewportAt1 unscaled viewport
 * @param {number} [dpi]
 * @returns {number} scale, clamped so the long edge lands in [MIN, MAX] px
 */
export function computeScale(viewportAt1, dpi = TARGET_DPI) {
  const width = Number(viewportAt1?.width) || 0;
  const height = Number(viewportAt1?.height) || 0;
  if (width <= 0 || height <= 0) return 1;

  const scale = (Number(dpi) || TARGET_DPI) / PDF_BASE_DPI;
  const longEdge = Math.max(width, height) * scale;

  if (longEdge > MAX_EDGE_PX) return scale * (MAX_EDGE_PX / longEdge);
  // Upscaling a small page (a card, a receipt slip) genuinely helps the model.
  if (longEdge < MIN_EDGE_PX) return scale * (MIN_EDGE_PX / longEdge);
  return scale;
}

/** Integer canvas dimensions for a viewport already scaled by `computeScale`. */
export function canvasSize(scaledViewport) {
  return {
    width: Math.max(1, Math.floor(scaledViewport.width)),
    height: Math.max(1, Math.floor(scaledViewport.height)),
  };
}
