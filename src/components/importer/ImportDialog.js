'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/common/Button';
import { Dialog } from '@/components/common/Dialog';
import { ErrorBanner } from '@/components/feedback/ErrorBanner';
import { toAppError } from '@/lib/errors';
import { parseArchive, restoreArchive } from '@/lib/export/importer';

/**
 * Import dialog (spec §25.3): pick archive → validate → summary → confirm.
 * Nothing is written to storage until the user confirms a valid archive.
 */
export function ImportDialog({ open, onClose, onImported }) {
  const inputRef = useRef(null);
  const [fileName, setFileName] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) {
      setFileName(null);
      setParsed(null);
      setError(null);
      setValidating(false);
      setImporting(false);
    }
  }, [open]);

  const pickFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    setParsed(null);
    setError(null);
    setValidating(true);
    try {
      setParsed(await parseArchive(file));
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setValidating(false);
    }
  };

  const confirm = async () => {
    if (!parsed) return;
    setImporting(true);
    setError(null);
    try {
      // Report uploads, not records: "4 documents" for one three-page PDF
      // would not match anything the user sees in the sidebar.
      const { rootCount } = await restoreArchive(parsed);
      onImported(rootCount);
      onClose();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import data"
      footer={
        <>
          <Button onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={!parsed || importing}>
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">
          Choose a Simple OCR export archive (.zip). It is validated before anything is written
          to browser storage.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            pickFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Button onClick={() => inputRef.current?.click()} disabled={validating || importing}>
          {fileName ? 'Choose a different file' : 'Choose archive…'}
        </Button>

        {fileName ? (
          <p className="text-[13px] text-ink-muted">
            Selected: <span className="font-medium text-ink">{fileName}</span>
            {validating ? ' — validating…' : ''}
          </p>
        ) : null}

        {parsed ? (
          <div
            className="rounded-md border border-success-edge bg-success-soft px-3 py-2.5 text-[13px] text-success"
            role="status"
          >
            Archive is valid: {parsed.summary.rootCount}{' '}
            {parsed.summary.rootCount === 1 ? 'document' : 'documents'}
            {parsed.summary.documentCount > parsed.summary.rootCount
              ? ` (${parsed.summary.documentCount - parsed.summary.rootCount} pages)`
              : ''}{' '}
            and {parsed.summary.fileCount} original{' '}
            {parsed.summary.fileCount === 1 ? 'file' : 'files'}. Documents that already exist here
            will be imported as copies.
          </div>
        ) : null}

        <ErrorBanner error={error} />
      </div>
    </Dialog>
  );
}
