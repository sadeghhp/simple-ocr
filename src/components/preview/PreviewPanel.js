'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Spinner } from '@/components/feedback/Spinner';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { FileIcon, ImageIcon } from '@/components/common/icons';
import { useDocumentFile } from '@/hooks/useDocumentFile';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { formatBytes } from '@/lib/files/convert';
import { PREVIEW_KIND, previewKind } from '@/lib/files/validation';

function ImagePreview({ url, name }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={`Preview of ${name}`}
        className="max-h-full max-w-full rounded-md border border-edge bg-white object-contain shadow-sm"
      />
    </div>
  );
}

function PdfPreview({ url, name }) {
  return (
    <iframe
      src={url}
      title={`Preview of ${name}`}
      // A blob: URL inherits this page's origin. `allow-scripts` WITHOUT
      // `allow-same-origin` gives the frame an opaque origin: the built-in PDF
      // viewer still runs, but a stored file cannot reach local data.
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  );
}

function TextPreview({ blob }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    let cancelled = false;
    blob
      .text()
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch(() => {
        if (!cancelled) setText('');
      });
    return () => {
      cancelled = true;
    };
  }, [blob]);
  if (text === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap p-5 font-mono text-[13px] leading-relaxed text-ink">
      {text}
    </pre>
  );
}

function UnsupportedPreview({ doc }) {
  return (
    <EmptyState icon={<FileIcon size={28} />} title="Preview not available">
      This file is stored safely in your browser, but it cannot be previewed here.
      <dl className="mt-3 space-y-1 text-[12px] text-ink-faint">
        <div>
          <dt className="inline font-medium">Type: </dt>
          <dd className="inline">{doc.mimeType || 'unknown'}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Size: </dt>
          <dd className="inline">{formatBytes(doc.size)}</dd>
        </div>
      </dl>
    </EmptyState>
  );
}

/** Center preview area (spec §9.2, §4.8). */
export function PreviewPanel({ doc }) {
  const { file, loading } = useDocumentFile(doc?.fileId ?? null);
  const url = useObjectUrl(file?.blob ?? null);

  if (!doc) {
    return (
      <EmptyState icon={<ImageIcon size={28} />} title="No document selected">
        Select a document from the list, or upload a new file to begin.
      </EmptyState>
    );
  }

  const kind = previewKind(doc.mimeType);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-panel px-4 py-3">
        <h2 className="truncate text-sm font-semibold text-ink" title={doc.name}>
          {doc.name}
        </h2>
        <span className="text-[12px] text-ink-faint">
          {doc.mimeType} · {formatBytes(doc.size)}
        </span>
        <span className="ml-auto">
          <StatusBadge status={doc.status} />
        </span>
      </header>
      <div className="min-h-0 flex-1 bg-surface">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : !file ? (
          <EmptyState title="Original file missing">
            The stored file for this document could not be found.
          </EmptyState>
        ) : kind === PREVIEW_KIND.image && url ? (
          <ImagePreview url={url} name={doc.name} />
        ) : kind === PREVIEW_KIND.pdf && url ? (
          <PdfPreview url={url} name={doc.name} />
        ) : kind === PREVIEW_KIND.text ? (
          <TextPreview blob={file.blob} />
        ) : (
          <UnsupportedPreview doc={doc} />
        )}
      </div>
    </div>
  );
}
