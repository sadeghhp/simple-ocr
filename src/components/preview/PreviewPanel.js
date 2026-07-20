'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Spinner } from '@/components/feedback/Spinner';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { FileIcon, ImageIcon } from '@/components/common/icons';
import { useAppState } from '@/hooks/useAppState';
import { useDocumentFile } from '@/hooks/useDocumentFile';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { formatBytes } from '@/lib/files/convert';
import { PREVIEW_KIND, previewKind } from '@/lib/files/validation';
import { DOCUMENT_KIND } from '@/lib/db/documents';
import { renderPageCached } from '@/lib/pdf/render';
import { toAppError, userMessage } from '@/lib/errors';

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
      // No `sandbox`: Chrome refuses to load its built-in PDF viewer in an
      // opaque-origin frame ("This page has been blocked by Chrome"), and
      // `allow-scripts allow-same-origin` on a same-origin blob: URL is a
      // sandbox the frame can escape anyway. The blob is the user's own file
      // and never leaves the browser.
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

/**
 * One rendered page of a parent PDF.
 *
 * Rendered on demand rather than stored: page images for a large document run
 * to tens of megabytes, and the shared LRU cache makes flipping between pages
 * cheap without spending the storage quota.
 */
function PagePreview({ doc, blob }) {
  const [state, setState] = useState({ blob: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ blob: null, error: null });
    renderPageCached(doc.fileId, blob, doc.pageNumber)
      .then((image) => {
        if (!cancelled) setState({ blob: image, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ blob: null, error: toAppError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [doc.fileId, doc.pageNumber, blob]);

  const url = useObjectUrl(state.blob);

  if (state.error) {
    return (
      <EmptyState title="This page could not be rendered">
        {userMessage(state.error)}
      </EmptyState>
    );
  }
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  return <ImagePreview url={url} name={`Page ${doc.pageNumber} of ${doc.name}`} />;
}

/**
 * Shown when extraction has renamed a document. The uploaded filename is the
 * only way back to a document the user knows by its scanner name, so it stays
 * visible rather than living in a menu.
 */
function RenamedNotice({ doc }) {
  const { restoreName } = useAppState();
  if (doc.kind === DOCUMENT_KIND.page) return null;
  if (!doc.originalName || doc.originalName === doc.name) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
      <span className="truncate" title={doc.originalName}>
        was {doc.originalName}
      </span>
      <button
        type="button"
        onClick={() => restoreName(doc.id)}
        className="shrink-0 rounded px-1 underline underline-offset-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Restore
      </button>
    </span>
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
          {doc.kind === DOCUMENT_KIND.page
            ? `Page ${doc.pageNumber}${doc.documentType ? ` · ${doc.documentType.replace(/_/g, ' ')}` : ''}`
            : `${doc.mimeType} · ${formatBytes(doc.size)}${
                doc.pageCount ? ` · ${doc.pageCount} pages` : ''
              }`}
        </span>
        <RenamedNotice doc={doc} />
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
        ) : doc.kind === DOCUMENT_KIND.page ? (
          // Pages select their renderer from `kind`, not mimeType — they carry
          // the parent's application/pdf so the export type-agreement check,
          // which is security-relevant, keeps holding.
          <PagePreview doc={doc} blob={file.blob} />
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
