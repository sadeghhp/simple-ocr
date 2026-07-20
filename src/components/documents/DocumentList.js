'use client';

import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ChevronRightIcon, FileIcon } from '@/components/common/icons';
import { formatBytes, formatDate } from '@/lib/files/convert';
import { SUPPORTED_TYPES_LABEL } from '@/lib/files/validation';
import { summarizePages } from '@/lib/pipeline/status';

function typeLabel(mimeType) {
  if (!mimeType) return 'File';
  if (mimeType.startsWith('image/')) return mimeType.slice(6).toUpperCase();
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'text/plain') return 'TXT';
  if (mimeType === 'text/markdown') return 'MD';
  return mimeType;
}

const rowClasses = (selected) =>
  `w-full rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
    selected ? 'border-accent-edge bg-accent-soft' : 'border-transparent hover:bg-panel-muted'
  }`;

function PageListItem({ page, selected, onSelect }) {
  const label = page.documentType
    ? `Page ${page.pageNumber} · ${page.documentType.replace(/_/g, ' ')}`
    : `Page ${page.pageNumber}`;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(page.id)}
        aria-current={selected ? 'true' : undefined}
        className={`${rowClasses(selected)} py-2`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink">{label}</span>
          <StatusBadge status={page.status} />
        </div>
      </button>
    </li>
  );
}

function DocumentListItem({ doc, pages, selected, selectedId, onSelect }) {
  const hasPages = pages.length > 0;
  const [expanded, setExpanded] = useState(false);

  // Opening a page from elsewhere (a retry, a deep link) must reveal it.
  const containsSelection = hasPages && pages.some((page) => page.id === selectedId);
  useEffect(() => {
    if (containsSelection) setExpanded(true);
  }, [containsSelection]);

  return (
    <li>
      <div className="flex items-stretch gap-1">
        {hasPages ? (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} pages of ${doc.name}`}
            className="shrink-0 rounded-md px-1 text-ink-faint hover:bg-panel-muted focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronRightIcon
              size={14}
              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onSelect(doc.id)}
          aria-current={selected ? 'true' : undefined}
          className={`${rowClasses(selected)} min-w-0 flex-1`}
        >
          <div className="flex items-center justify-between gap-2">
            {/* The original filename stays discoverable on hover once
                extraction has renamed the document. */}
            <span
              className="truncate text-sm font-medium text-ink"
              title={doc.originalName && doc.originalName !== doc.name ? doc.originalName : doc.name}
            >
              {doc.name}
            </span>
            <StatusBadge
              status={doc.status}
              pages={hasPages ? summarizePages(pages) : null}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-faint">
            <span>{typeLabel(doc.mimeType)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(doc.size)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(doc.createdAt)}</span>
          </div>
        </button>
      </div>

      {hasPages && expanded ? (
        <ul aria-label={`Pages of ${doc.name}`} className="mt-1 space-y-1 border-l border-edge pl-3 ml-3">
          {pages.map((page) => (
            <PageListItem
              key={page.id}
              page={page}
              selected={page.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function DocumentList({ documents, childrenByParent, loaded, selectedId, onSelect }) {
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
          pages={childrenByParent?.get(doc.id) ?? []}
          selected={doc.id === selectedId}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
