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
};

export function StatusBadge({ status }) {
  const style = STYLES[status] ?? STYLES[DOCUMENT_STATUS.ready];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${style.className}`}
    >
      {style.label}
    </span>
  );
}
