import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES, errorHint, toAppError, userMessage } from '@/lib/errors';

describe('error code coverage', () => {
  // A code with no entry in USER_MESSAGES silently renders "Something went
  // wrong", which is indistinguishable from a genuine unknown failure. Phases
  // 3 and 4 add several more codes, so this guard has to exist before then.
  it.each(Object.keys(ERROR_CODES).filter((code) => code !== 'UNKNOWN'))(
    '%s has a user-facing message',
    (code) => {
      const message = userMessage({ code });
      expect(message).toBeTruthy();
      expect(message, `${code} falls through to the UNKNOWN message`).not.toBe(
        userMessage({ code: 'UNKNOWN' })
      );
    }
  );

  it('keeps ERROR_CODES self-consistent', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
    }
  });

  it('falls back to UNKNOWN for an unrecognised code', () => {
    expect(new AppError('NOT_A_REAL_CODE', 'x').code).toBe(ERROR_CODES.UNKNOWN);
  });
});

describe('extraction and PDF errors carry guidance', () => {
  const actionable = [
    'EXTRACTION_NOT_JSON',
    'EXTRACTION_TRUNCATED',
    'EXTRACTION_SCHEMA_MISMATCH',
    'PDF_ENCRYPTED',
    'PDF_RENDER_FAILED',
    'PDF_TOO_MANY_PAGES',
    'PAGE_PARTIAL_FAILURE',
    'PROCESSING_CANCELLED',
  ];

  it.each(actionable)('%s tells the user what to do next', (code) => {
    expect(errorHint({ code })).toBeTruthy();
  });

  it('lets an error carry a more specific hint than the default', () => {
    const err = new AppError(ERROR_CODES.EXTRACTION_NOT_JSON, 'x', { hint: 'Specific advice.' });
    expect(errorHint(err)).toBe('Specific advice.');
  });

  it('round-trips through toRecord for persistence', () => {
    const err = new AppError(ERROR_CODES.EXTRACTION_TRUNCATED, 'cut off', {
      retryable: true,
      detail: 'reply ended mid-string',
      documentId: 'page-3',
    });
    const record = err.toRecord();
    expect(record.code).toBe('EXTRACTION_TRUNCATED');
    expect(record.retryable).toBe(true);
    expect(record.documentId).toBe('page-3');
    expect(userMessage(record)).toBe(userMessage(err));
  });

  it('does not double-wrap an AppError', () => {
    const err = new AppError(ERROR_CODES.PDF_ENCRYPTED, 'locked');
    expect(toAppError(err)).toBe(err);
  });
});
