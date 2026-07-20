/**
 * File validation at the upload boundary (spec §19).
 */
import { AppError, ERROR_CODES } from '@/lib/errors';

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB recommended maximum

export const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
]);

const EXTENSION_MIME_FALLBACK = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
};

export const ACCEPT_ATTRIBUTE = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md';

export const SUPPORTED_TYPES_LABEL = 'PNG, JPEG, WebP, GIF, PDF, TXT, MD';

/** Resolve the effective MIME type, falling back to the file extension. */
export function detectMimeType(file) {
  if (file.type && SUPPORTED_MIME_TYPES.has(file.type)) return file.type;
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  return EXTENSION_MIME_FALLBACK[ext] || file.type || '';
}

export function isSupportedFile(file) {
  return SUPPORTED_MIME_TYPES.has(detectMimeType(file));
}

/** Allowlist check for a bare MIME string (used when validating imports). */
export function isSupportedMimeType(mimeType) {
  return SUPPORTED_MIME_TYPES.has(mimeType);
}

/**
 * Validate one file for upload. Throws AppError on rejection,
 * returns `{ mimeType }` on success.
 */
export function validateFile(file) {
  if (!file) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_FILE, 'No file provided');
  }
  const mimeType = detectMimeType(file);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new AppError(
      ERROR_CODES.UNSUPPORTED_FILE,
      `Unsupported file type: ${file.type || file.name}`
    );
  }
  if (file.size === 0) {
    throw new AppError(ERROR_CODES.EMPTY_FILE, `File is empty: ${file.name}`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AppError(
      ERROR_CODES.FILE_TOO_LARGE,
      `File exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB: ${file.name}`
    );
  }
  return { mimeType };
}

export const PREVIEW_KIND = {
  image: 'image',
  pdf: 'pdf',
  text: 'text',
  unsupported: 'unsupported',
};

export function previewKind(mimeType) {
  if (!mimeType) return PREVIEW_KIND.unsupported;
  if (mimeType.startsWith('image/')) return PREVIEW_KIND.image;
  if (mimeType === 'application/pdf') return PREVIEW_KIND.pdf;
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') return PREVIEW_KIND.text;
  return PREVIEW_KIND.unsupported;
}
