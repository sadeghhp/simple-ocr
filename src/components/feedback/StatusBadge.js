'use client';

import { DOCUMENT_STATUS } from '@/lib/db/documents';

/** Status is communicated with a label, not color alone (spec §21). */
const STYLES = {
  [DOCUMENT_STATUS.uploaded]: { label: 'Uploaded', className: 'bg-panel-muted text-ink-muted border-edge' },
  [DOCUMENT_STATUS.ready]: { label: 'Ready', className: 'bg-panel-muted text-ink-muted border-edge' },
  [DOCUMENT_STATUS.processing]: {
    label: 'Processing…',
    className: 'bg-accent-soft text-accent border-accent-edge',
  },
  [DOCUMENT_STATUS.completed]: {
    label: 'Completed',
    className: 'bg-success-soft text-success border-success-edge',
  },
  [DOCUMENT_STATUS.failed]: { label: 'Failed', className: 'bg-danger-soft text-danger border-danger-edge' },
  [DOCUMENT_STATUS.partial]: {
    label: 'Some pages failed',
    className: 'bg-warning-soft text-warning border-warning-edge',
  },
};

/**
 * @param {object} props
 * @param {string} props.status
 * @param {{total: number, completed: number, failed: number}} [props.pages]
 *   when given, the label reports page progress instead of a bare status —
 *   "Failed" on a 40-page document says nothing about what survived.
 */
export function StatusBadge({ status, pages = null }) {
  const style = STYLES[status] ?? STYLES[DOCUMENT_STATUS.ready];
  let label = style.label;

  if (pages && pages.total > 0) {
    if (status === DOCUMENT_STATUS.processing) {
      label = `Page ${Math.min(pages.completed + pages.failed + 1, pages.total)} of ${pages.total}…`;
    } else if (status === DOCUMENT_STATUS.partial) {
      label = `${pages.completed} of ${pages.total} pages`;
    } else if (status === DOCUMENT_STATUS.completed) {
      label = `${pages.total} pages`;
    }
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${style.className}`}
    >
      {label}
    </span>
  );
}
