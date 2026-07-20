'use client';

import { StatusBadge } from '@/components/feedback/StatusBadge';
import { EmptyState } from '@/components/feedback/EmptyState';
import { FileIcon } from '@/components/common/icons';
import { formatBytes, formatDate } from '@/lib/files/convert';
import { SUPPORTED_TYPES_LABEL } from '@/lib/files/validation';

function typeLabel(mimeType) {
  if (!mimeType) return 'File';
  if (mimeType.startsWith('image/')) return mimeType.slice(6).toUpperCase();
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'text/plain') return 'TXT';
  if (mimeType === 'text/markdown') return 'MD';
  return mimeType;
}

function DocumentListItem({ doc, selected, onSelect }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(doc.id)}
        aria-current={selected ? 'true' : undefined}
        className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          selected
            ? 'border-accent-edge bg-accent-soft'
            : 'border-transparent hover:bg-panel-muted'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink">{doc.name}</span>
          <StatusBadge status={doc.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-faint">
          <span>{typeLabel(doc.mimeType)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(doc.size)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDate(doc.createdAt)}</span>
        </div>
      </button>
    </li>
  );
}

export function DocumentList({ documents, loaded, selectedId, onSelect }) {
  if (loaded && documents.length === 0) {
    return (
      <EmptyState icon={<FileIcon size={28} />} title="No documents yet">
        Upload a file to get started. Files are stored only in this browser.
        <p className="mt-2 text-[12px] text-ink-faint">Supported: {SUPPORTED_TYPES_LABEL}</p>
      </EmptyState>
    );
  }
  return (
    <ul aria-label="Documents" className="space-y-1 p-2">
      {documents.map((doc) => (
        <DocumentListItem
          key={doc.id}
          doc={doc}
          selected={doc.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
