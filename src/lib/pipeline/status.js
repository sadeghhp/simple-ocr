/**
 * Parent status is *derived* from its pages, never set directly.
 *
 * Pure so the state machine can be exhaustively tested without a database —
 * this is the logic a tab closed mid-run is most likely to corrupt.
 */
import { DOCUMENT_STATUS } from '@/lib/db/documents';

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

/** Parent text: every page in order, with page markers so structure survives. */
export function joinPageText(children) {
  return (Array.isArray(children) ? children : [])
    .slice()
    .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
    .filter((page) => (page.editedText ?? page.extractedText) != null)
    .map((page) => `--- Page ${page.pageNumber} ---\n${page.editedText ?? page.extractedText}`)
    .join('\n\n');
}
