/**
 * Parent status is *derived* from its pages, never set directly.
 *
 * Pure so the state machine can be exhaustively tested without a database —
 * this is the logic a tab closed mid-run is most likely to corrupt.
 */
import { DOCUMENT_STATUS } from '@/lib/db/documents';
import { ERROR_CODES } from '@/lib/errors';

/**
 * @param {Array<{status: string}>} children
 * @returns {string} one of DOCUMENT_STATUS
 */
export function deriveParentStatus(children) {
  const pages = Array.isArray(children) ? children : [];
  if (pages.length === 0) return DOCUMENT_STATUS.ready;

  const count = (status) => pages.filter((p) => p.status === status).length;
  const processing = count(DOCUMENT_STATUS.processing);
  const completed = count(DOCUMENT_STATUS.completed);
  const failed = count(DOCUMENT_STATUS.failed);

  // Any page still running makes the whole document running.
  if (processing > 0) return DOCUMENT_STATUS.processing;
  if (completed === pages.length) return DOCUMENT_STATUS.completed;
  if (failed === pages.length) return DOCUMENT_STATUS.failed;
  // A mix of finished and unfinished pages is `partial` — reporting `failed`
  // for a document with 40 good pages and 2 bad ones would misrepresent it.
  if (completed > 0 || failed > 0) return DOCUMENT_STATUS.partial;
  return DOCUMENT_STATUS.ready;
}

/** Page counts for progress display. */
export function summarizePages(children) {
  const pages = Array.isArray(children) ? children : [];
  return {
    total: pages.length,
    completed: pages.filter((p) => p.status === DOCUMENT_STATUS.completed).length,
    failed: pages.filter((p) => p.status === DOCUMENT_STATUS.failed).length,
    processing: pages.filter((p) => p.status === DOCUMENT_STATUS.processing).length,
  };
}

/**
 * The error to store on a parent, derived from its pages.
 *
 * When every page failed the same way, the parent reports that failure
 * verbatim. Replacing it with a generic "some pages could not be extracted"
 * throws away the only actionable information there is — a CORS rejection or a
 * bad API key gets reported as a vague page problem, and the suggested fix
 * ("retry the failed pages") is guaranteed to fail the same way.
 *
 * @param {Array} children
 * @returns {object|null} a persisted error record, or null when nothing failed
 */
export function deriveParentError(children) {
  const pages = Array.isArray(children) ? children : [];
  const failed = pages.filter((p) => p.status === DOCUMENT_STATUS.failed);
  if (failed.length === 0) return null;

  const errors = failed.map((p) => p.processingError).filter(Boolean);
  const codes = new Set(errors.map((e) => e.code));

  // Every page failed, and for one shared reason: that reason IS the document's.
  if (failed.length === pages.length && codes.size === 1 && errors.length > 0) {
    const shared = errors[0];
    return {
      ...shared,
      message: `Every page failed: ${shared.message}`,
    };
  }

  const completed = pages.filter((p) => p.status === DOCUMENT_STATUS.completed).length;
  const sharedCode = codes.size === 1 ? [...codes][0] : null;
  return {
    code: ERROR_CODES.PAGE_PARTIAL_FAILURE,
    message: `${failed.length} of ${pages.length} pages failed`,
    detail: errors.length > 0 ? errors.map((e) => e.detail || e.message).join('\n') : null,
    hint: sharedCode
      ? `${completed} ${completed === 1 ? 'page' : 'pages'} extracted. The rest failed the same way — open a failed page for the reason.`
      : 'Open the document and retry the pages that failed.',
    retryable: true,
    documentId: null,
    createdAt: new Date().toISOString(),
  };
}

/** Parent text: every page in order, with page markers so structure survives. */
export function joinPageText(children) {
  return (Array.isArray(children) ? children : [])
    .slice()
    .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
    .filter((page) => (page.editedText ?? page.extractedText) != null)
    .map((page) => `--- Page ${page.pageNumber} ---\n${page.editedText ?? page.extractedText}`)
    .join('\n\n');
}
