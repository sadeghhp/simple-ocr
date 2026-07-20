import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  detectMimeType,
  previewKind,
  validateFile,
} from '@/lib/files/validation';

const makeFile = (name, type, size = 100) =>
  new File([new Uint8Array(size)], name, { type });

describe('validateFile', () => {
  it('accepts supported image, pdf, and text files', () => {
    expect(validateFile(makeFile('a.png', 'image/png')).mimeType).toBe('image/png');
    expect(validateFile(makeFile('a.pdf', 'application/pdf')).mimeType).toBe('application/pdf');
    expect(validateFile(makeFile('a.txt', 'text/plain')).mimeType).toBe('text/plain');
  });

  it('falls back to the file extension when the MIME type is missing', () => {
    expect(validateFile(makeFile('scan.jpg', '')).mimeType).toBe('image/jpeg');
    expect(detectMimeType(makeFile('notes.md', ''))).toBe('text/markdown');
  });

  it('rejects unsupported types', () => {
    expect(() => validateFile(makeFile('a.docx', 'application/msword'))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE' })
    );
  });

  it('rejects empty files', () => {
    expect(() => validateFile(makeFile('a.png', 'image/png', 0))).toThrowError(
      expect.objectContaining({ code: 'EMPTY_FILE' })
    );
  });

  it('rejects files above the size limit', () => {
    const big = { name: 'big.png', type: 'image/png', size: MAX_FILE_BYTES + 1 };
    expect(() => validateFile(big)).toThrowError(
      expect.objectContaining({ code: 'FILE_TOO_LARGE' })
    );
  });
});

describe('previewKind', () => {
  it('classifies preview types', () => {
    expect(previewKind('image/webp')).toBe('image');
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('text/plain')).toBe('text');
    expect(previewKind('application/zip')).toBe('unsupported');
    expect(previewKind(null)).toBe('unsupported');
  });
});
