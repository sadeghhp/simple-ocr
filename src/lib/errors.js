/**
 * Normalized application errors (spec §20).
 * All failures crossing a layer boundary should be an AppError so the UI
 * can map codes to human-readable messages.
 */

export const ERROR_CODES = {
  UNSUPPORTED_FILE: 'UNSUPPORTED_FILE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  EMPTY_FILE: 'EMPTY_FILE',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  INVALID_ENDPOINT: 'INVALID_ENDPOINT',
  CORS_BLOCKED: 'CORS_BLOCKED',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  NO_PROVIDER_AVAILABLE: 'NO_PROVIDER_AVAILABLE',
  MODEL_REJECTED_INPUT: 'MODEL_REJECTED_INPUT',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  EMPTY_COMPLETION: 'EMPTY_COMPLETION',
  CONTENT_FILTERED: 'CONTENT_FILTERED',
  RESPONSE_TRUNCATED: 'RESPONSE_TRUNCATED',
  NOT_JSON_RESPONSE: 'NOT_JSON_RESPONSE',
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  IMPORT_INVALID: 'IMPORT_INVALID',
  ALREADY_PROCESSING: 'ALREADY_PROCESSING',
  PROCESSING_INTERRUPTED: 'PROCESSING_INTERRUPTED',
  PROCESSING_CANCELLED: 'PROCESSING_CANCELLED',
  EXTRACTION_NOT_JSON: 'EXTRACTION_NOT_JSON',
  EXTRACTION_TRUNCATED: 'EXTRACTION_TRUNCATED',
  EXTRACTION_SCHEMA_MISMATCH: 'EXTRACTION_SCHEMA_MISMATCH',
  PDF_RENDER_FAILED: 'PDF_RENDER_FAILED',
  PDF_ENCRYPTED: 'PDF_ENCRYPTED',
  PDF_NO_PAGES: 'PDF_NO_PAGES',
  PDF_TOO_MANY_PAGES: 'PDF_TOO_MANY_PAGES',
  PAGE_PARTIAL_FAILURE: 'PAGE_PARTIAL_FAILURE',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_NAME: 'INVALID_NAME',
  UNKNOWN: 'UNKNOWN',
};

export class AppError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message technical summary (never shown as the headline)
   * @param {object} options
   * @param {string} [options.detail] verbatim provider/browser diagnostic, shown
   *   in the collapsible "Technical details" section
   * @param {string} [options.hint] actionable next step shown under the headline
   */
  constructor(
    code,
    message,
    { retryable = false, cause = null, documentId = null, detail = null, hint = null } = {}
  ) {
    super(message);
    this.name = 'AppError';
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.UNKNOWN;
    this.retryable = retryable;
    this.cause = cause;
    this.documentId = documentId;
    this.detail = detail;
    this.hint = hint;
    this.createdAt = new Date().toISOString();
  }

  /** Plain-object form safe to persist in IndexedDB. */
  toRecord() {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      hint: this.hint,
      retryable: this.retryable,
      documentId: this.documentId,
      createdAt: this.createdAt,
    };
  }
}

/** Wrap any thrown value into an AppError without double-wrapping. */
export function toAppError(err, fallbackCode = ERROR_CODES.UNKNOWN) {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
    return new AppError(ERROR_CODES.STORAGE_QUOTA_EXCEEDED, message, { cause: err });
  }
  // Keep the DOMException name. IndexedDB failures are distinguished almost
  // entirely by name — TransactionInactiveError, NotFoundError,
  // ConstraintError — and several browsers leave the message blank, so
  // dropping it leaves a storage failure with nothing to diagnose from.
  const name = err?.name && err.name !== 'Error' ? err.name : null;
  return new AppError(fallbackCode, message || name || 'Unknown failure', {
    cause: err,
    detail: name ? `${name}${message ? `: ${message}` : ''}` : null,
  });
}

const USER_MESSAGES = {
  UNSUPPORTED_FILE: 'This file type is not supported.',
  FILE_TOO_LARGE: 'This file is larger than the recommended maximum size.',
  EMPTY_FILE: 'This file is empty and cannot be processed.',
  PROVIDER_NOT_CONFIGURED:
    'No OCR provider is configured yet. Open Settings and add your provider details first.',
  INVALID_ENDPOINT: 'The provider endpoint is not a valid URL. Check it in Settings.',
  CORS_BLOCKED:
    'The provider refused the request from the browser (CORS). The endpoint must allow cross-origin requests. Your file is still stored safely.',
  AUTHENTICATION_FAILED:
    'The provider rejected the API key. Check the key in Settings. Your file is still stored safely.',
  RATE_LIMITED: 'The provider is rate-limiting requests. Wait a moment and retry.',
  INVALID_RESPONSE:
    'The provider replied, but the response did not contain any extracted text. Your file is still stored safely.',
  NETWORK_ERROR:
    'The request could not reach the provider. This may be a network problem or a CORS restriction. Your file is still stored safely.',
  PROVIDER_ERROR: 'The provider returned an error. Your file is still stored safely.',
  MODEL_NOT_FOUND:
    'The provider does not recognise this model name. Your file is still stored safely.',
  NO_PROVIDER_AVAILABLE:
    'The gateway could not route this request to any upstream provider. Your file is still stored safely.',
  MODEL_REJECTED_INPUT:
    'The model could not accept this file. It may not support images or PDFs. Your file is still stored safely.',
  INSUFFICIENT_CREDITS:
    'The provider account has insufficient credits or has hit a spending limit.',
  EMPTY_COMPLETION:
    'The model returned an empty result. It read the request but produced no text. Your file is still stored safely.',
  CONTENT_FILTERED:
    'The model refused to process this document because of its content safety filters.',
  RESPONSE_TRUNCATED:
    'The model stopped before returning any text because it hit its output length limit.',
  NOT_JSON_RESPONSE:
    'The endpoint replied with something that is not an API response. The URL may be wrong. Your file is still stored safely.',
  STORAGE_QUOTA_EXCEEDED:
    'The browser storage quota is full. Delete some documents or free up disk space, then try again.',
  STORAGE_ERROR: 'The browser database could not complete the operation.',
  IMPORT_INVALID: 'This file is not a valid export archive.',
  ALREADY_PROCESSING: 'This document is already being processed.',
  PROCESSING_INTERRUPTED:
    'Processing stopped when the app was closed or reloaded. Your file is still stored safely.',
  PROCESSING_CANCELLED: 'Processing was cancelled. Your file is still stored safely.',
  EXTRACTION_NOT_JSON:
    'The model returned text but not structured data. The text was kept — only the fields are missing.',
  EXTRACTION_TRUNCATED:
    'The model’s reply was cut off, so some fields may be incomplete. The text that arrived was kept.',
  EXTRACTION_SCHEMA_MISMATCH:
    'The model returned structured data in an unexpected shape. The text was kept.',
  PDF_RENDER_FAILED: 'This PDF page could not be rendered. Your file is still stored safely.',
  PDF_ENCRYPTED: 'This PDF is password-protected, so its pages cannot be read.',
  PDF_NO_PAGES: 'This PDF contains no pages.',
  PDF_TOO_MANY_PAGES: 'This PDF has more pages than the app will process in one document.',
  PAGE_PARTIAL_FAILURE: 'Some pages of this document could not be extracted.',
  NOT_FOUND: 'The requested record no longer exists.',
  INVALID_NAME: 'That name cannot be used.',
  UNKNOWN: 'Something went wrong.',
};

/**
 * Fallback next-step guidance per code, used when the error itself did not
 * carry a more specific `hint`.
 */
const DEFAULT_HINTS = {
  PROCESSING_INTERRUPTED: 'Press Retry to extract the text again.',
  INVALID_RESPONSE:
    'Open the technical details below to see exactly what the provider sent back.',
  EMPTY_COMPLETION:
    'Try a different model, or simplify the OCR instruction in Settings. Some models return nothing for low-quality scans.',
  MODEL_NOT_FOUND:
    'Check the exact model identifier on your provider’s models page and copy it into Settings.',
  NO_PROVIDER_AVAILABLE:
    'On OpenRouter this usually means your privacy settings exclude every provider that serves this model — check openrouter.ai/settings/privacy. It can also mean the model does not accept image or file input.',
  MODEL_REJECTED_INPUT:
    'Pick a vision-capable model in Settings, or upload an image instead of a PDF.',
  AUTHENTICATION_FAILED:
    'Check the API key in Settings, including any leading or trailing spaces.',
  RATE_LIMITED: 'Wait a few seconds, then use Retry.',
  INSUFFICIENT_CREDITS: 'Add credits or raise the spending limit in your provider account.',
  NOT_JSON_RESPONSE:
    'Check the endpoint URL in Settings. It should be the full chat completions path.',
  NETWORK_ERROR:
    'Check your connection, then confirm the endpoint allows browser requests (CORS).',
  CORS_BLOCKED: 'The provider must send Access-Control-Allow-Origin for browser requests.',
  STORAGE_QUOTA_EXCEEDED: 'Export your data, then delete documents you no longer need.',
  EXTRACTION_NOT_JSON:
    'Press Retry to try again. If it keeps happening, this model may not follow JSON instructions well — try a different one in Settings.',
  EXTRACTION_TRUNCATED:
    'This usually means a long page hit the model’s output limit. Retry, or try a model with a larger output budget.',
  EXTRACTION_SCHEMA_MISMATCH: 'Press Retry, or switch to a different model in Settings.',
  PDF_ENCRYPTED: 'Remove the password from the PDF, then upload it again.',
  PDF_RENDER_FAILED:
    'The PDF may be damaged. Try opening it in another viewer and re-saving it.',
  PDF_TOO_MANY_PAGES: 'Split the PDF into smaller files and upload them separately.',
  PAGE_PARTIAL_FAILURE: 'Open the document and retry the pages that failed.',
  PROCESSING_CANCELLED: 'Press Extract text to start again.',
};

/** Map an AppError (or persisted error record) to a user-facing headline. */
export function userMessage(errorLike) {
  if (!errorLike) return USER_MESSAGES.UNKNOWN;
  const base = USER_MESSAGES[errorLike.code] || USER_MESSAGES.UNKNOWN;
  if (errorLike.code === 'UNKNOWN' && errorLike.message) {
    return `${base} (${errorLike.message})`;
  }
  return base;
}

/** Actionable next step shown under the headline. */
export function errorHint(errorLike) {
  if (!errorLike) return null;
  return errorLike.hint || DEFAULT_HINTS[errorLike.code] || null;
}

/**
 * Verbatim technical diagnostic for the collapsible details section.
 * Always a plain string — provider text is never rendered as markup.
 */
export function errorDetail(errorLike) {
  if (!errorLike) return null;
  const parts = [];
  if (errorLike.code) parts.push(`Code: ${errorLike.code}`);
  if (errorLike.message) parts.push(`Summary: ${errorLike.message}`);
  if (errorLike.detail) parts.push(`Provider said: ${errorLike.detail}`);
  if (errorLike.createdAt) parts.push(`Time: ${errorLike.createdAt}`);
  return parts.length > 0 ? parts.join('\n') : null;
}
