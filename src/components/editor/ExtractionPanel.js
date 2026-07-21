'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/common/Button';
import { RetryIcon, SettingsIcon, SparkleIcon } from '@/components/common/icons';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorBanner } from '@/components/feedback/ErrorBanner';
import { Spinner } from '@/components/feedback/Spinner';
import { DOCUMENT_STATUS } from '@/lib/db/documents';
import { SAVE_STATE, useDebouncedSave } from '@/hooks/useDebouncedSave';
import {
  resetEditedText,
  resetExtractionFields,
  saveEditedText,
  saveExtractionFields,
} from '@/lib/workflows';
import { FieldEditor } from '@/components/extraction/FieldEditor';

/** Failures the user fixes in provider settings rather than by retrying. */
const SETTINGS_FIXABLE = new Set([
  'NOT_JSON_RESPONSE',
  'INVALID_ENDPOINT',
  'PROVIDER_NOT_CONFIGURED',
  'MODEL_NOT_FOUND',
  'NO_PROVIDER_AVAILABLE',
  'MODEL_REJECTED_INPUT',
  'AUTHENTICATION_FAILED',
  'NETWORK_ERROR',
  'CORS_BLOCKED',
]);

function SaveIndicator({ state, dirty }) {
  if (state === SAVE_STATE.saving) return <span className="text-[12px] text-ink-faint">Saving…</span>;
  if (state === SAVE_STATE.failed)
    return <span className="text-[12px] font-medium text-danger">Save failed</span>;
  if (state === SAVE_STATE.saved) return <span className="text-[12px] text-ink-faint">Saved</span>;
  if (dirty) return <span className="text-[12px] text-ink-faint">Edited</span>;
  return null;
}

/**
 * Right panel (spec §9.3): process action, status, editable extraction with
 * debounced auto-save (§14.3) and reset to the original extraction (§4.9).
 */
export function ExtractionPanel({
  doc,
  providerConfigured,
  processing,
  onProcess,
  onCancel,
  onOpenSettings,
  onDocumentChanged,
}) {
  const [text, setText] = useState('');
  const [fields, setFields] = useState(null);
  const [tab, setTab] = useState('fields');
  const [processError, setProcessError] = useState(null);
  const [resetting, setResetting] = useState(false);

  // The save target comes from the id queued with the edit, never from the
  // currently selected document — otherwise a pending save lands on whatever
  // document the user switched to.
  const {
    queue,
    flush,
    cancel,
    isPending,
    state: saveState,
    setState: setSaveState,
  } = useDebouncedSave(async (value, documentId) => {
    await saveEditedText(documentId, value);
    onDocumentChanged?.();
  });

  // Field edits save on their own schedule. Sharing the text hook would make
  // one queued edit overwrite the other, since each carries a whole value.
  const {
    queue: queueFields,
    flush: flushFields,
    cancel: cancelFields,
    isPending: isFieldsPending,
    state: fieldsSaveState,
    setState: setFieldsSaveState,
  } = useDebouncedSave(async (value, documentId) => {
    await saveExtractionFields(documentId, value);
    onDocumentChanged?.();
  });

  // Selection changed: write out any edit still pending (against its own id)
  // and reset the editor to the newly selected document.
  const docId = doc?.id ?? null;
  useEffect(() => {
    flush();
    flushFields();
    setText(doc?.editedText ?? '');
    setFields(doc?.extractionEdited ?? doc?.extraction?.fields ?? null);
    setProcessError(doc?.processingError ?? null);
    setSaveState(SAVE_STATE.idle);
    setFieldsSaveState(SAVE_STATE.idle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // A new extraction arrived for the document already on screen.
  //
  // This keys on `updatedAt`, not `processedAt`: a multi-page parent's results
  // are written by refreshParentStatus, which never sets `processedAt`. Keying
  // on it left the textarea showing '' for a document that had extracted fine,
  // and the first keystroke then saved that empty string over the page text.
  //
  // Only re-sync when nothing is queued locally, so a refresh landing mid-edit
  // cannot pull the text out from under whoever is typing.
  const updatedAt = doc?.updatedAt ?? null;
  useEffect(() => {
    if (!isPending()) setText(doc?.editedText ?? '');
    if (!isFieldsPending()) {
      setFields(doc?.extractionEdited ?? doc?.extraction?.fields ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, updatedAt]);

  useEffect(() => {
    setProcessError(doc?.processingError ?? null);
  }, [doc?.processingError]);

  if (!doc) {
    return (
      <EmptyState icon={<SparkleIcon size={28} />} title="Extracted text">
        Select a document to view or extract its text.
      </EmptyState>
    );
  }

  const isProcessing = processing || doc.status === DOCUMENT_STATUS.processing;
  const hasExtraction = doc.extractedText != null;
  const dirty = hasExtraction && text !== doc.extractedText;
  // Tracked against extractionEdited, deliberately separate from `dirty`:
  // reformatting a field is not the same edit as rewriting the text.
  const fieldsDirty = doc.extractionEdited != null;
  const structured = doc.extraction && !doc.extraction.degraded ? doc.extraction : null;
  const degraded = Boolean(doc.extraction?.degraded);
  const activeTab = structured ? tab : 'text';

  const startProcessing = async () => {
    setProcessError(null);
    await flush();
    await flushFields();
    const error = await onProcess(doc.id);
    if (error && error.code !== 'ALREADY_PROCESSING') setProcessError(error);
  };

  const handleReset = async () => {
    setResetting(true);
    // Discard any queued edit, or it would re-save over the reset.
    cancel();
    cancelFields();
    try {
      if (activeTab === 'fields') {
        await resetExtractionFields(doc.id);
        setFields(doc.extraction?.fields ?? null);
        setFieldsSaveState(SAVE_STATE.idle);
      } else {
        const updated = await resetEditedText(doc.id);
        setText(updated.extractedText ?? '');
        setSaveState(SAVE_STATE.idle);
      }
      onDocumentChanged?.();
    } finally {
      setResetting(false);
    }
  };

  const resetDisabled =
    isProcessing || resetting || (activeTab === 'fields' ? !fieldsDirty : !dirty);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Extracted text</h2>
        <span aria-live="polite" className="ml-auto">
          {isProcessing ? (
            <span className="inline-flex items-center gap-2 text-[12px] text-accent">
              <Spinner size={13} /> Processing…
            </span>
          ) : (
            <SaveIndicator
              state={activeTab === 'fields' ? fieldsSaveState : saveState}
              dirty={activeTab === 'fields' ? fieldsDirty : dirty}
            />
          )}
        </span>
      </header>

      {structured ? (
        <div role="tablist" aria-label="Extraction view" className="flex gap-1 border-b border-edge px-4">
          {[
            ['fields', 'Fields'],
            ['text', 'Raw text'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`extraction-tab-${key}`}
              aria-selected={activeTab === key}
              aria-controls={`extraction-panel-${key}`}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${
                activeTab === key
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {!providerConfigured && !hasExtraction ? (
          <EmptyState icon={<SettingsIcon size={26} />} title="Provider required">
            OCR needs a configured LLM provider. Nothing is sent anywhere until you start
            processing.
            <div className="mt-3">
              <Button variant="primary" size="sm" onClick={onOpenSettings}>
                Configure provider
              </Button>
            </div>
          </EmptyState>
        ) : (
          <>
            {processError ? (
              <ErrorBanner
                error={processError}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={startProcessing} disabled={isProcessing}>
                      <RetryIcon size={13} />
                      Retry
                    </Button>
                    {SETTINGS_FIXABLE.has(processError.code) ? (
                      <Button size="sm" onClick={onOpenSettings}>
                        <SettingsIcon size={13} />
                        Open settings
                      </Button>
                    ) : null}
                  </div>
                }
              />
            ) : null}

            {!hasExtraction && !isProcessing && !processError ? (
              <EmptyState icon={<SparkleIcon size={26} />} title="No extracted text yet">
                The original file is stored locally. Extraction sends this document to your
                configured provider.
              </EmptyState>
            ) : null}

            {degraded && hasExtraction ? (
              <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-[12px] text-warning">
                The model returned text but not structured fields, so only the raw text is
                available. Extract again to try for fields.
              </p>
            ) : null}

            {structured && activeTab === 'fields' ? (
              <div
                id="extraction-panel-fields"
                role="tabpanel"
                aria-labelledby="extraction-tab-fields"
                className="min-h-0 flex-1 overflow-y-auto"
              >
                <FieldEditor
                  extraction={{ ...doc.extraction, fields: fields ?? doc.extraction.fields }}
                  disabled={isProcessing}
                  onChange={(next) => {
                    setFields(next);
                    queueFields(next, doc.id);
                  }}
                />
              </div>
            ) : null}

            {(hasExtraction || isProcessing) && activeTab === 'text' ? (
              <textarea
                id="extraction-panel-text"
                role={structured ? 'tabpanel' : undefined}
                aria-labelledby={structured ? 'extraction-tab-text' : undefined}
                aria-label={structured ? undefined : 'Extracted text editor'}
                value={text}
                disabled={isProcessing}
                onChange={(event) => {
                  setText(event.target.value);
                  queue(event.target.value, doc.id);
                }}
                placeholder={isProcessing ? 'Waiting for the provider…' : ''}
                className="min-h-0 flex-1 resize-none rounded-md border border-edge-strong bg-panel p-3 font-mono text-[13px] leading-relaxed text-ink focus:outline-2 focus:outline-offset-1 focus:outline-accent disabled:bg-panel-muted"
                spellCheck={false}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={startProcessing}
                disabled={isProcessing || !providerConfigured}
              >
                <SparkleIcon size={14} />
                {isProcessing
                  ? 'Processing…'
                  : hasExtraction
                    ? 'Extract again'
                    : 'Extract text'}
              </Button>
              {isProcessing && onCancel ? (
                <Button onClick={() => onCancel(doc.id)}>Cancel</Button>
              ) : null}
              {hasExtraction ? (
                <Button onClick={handleReset} disabled={resetDisabled}>
                  {resetting ? 'Resetting…' : 'Reset to extraction'}
                </Button>
              ) : null}
              {!providerConfigured && hasExtraction ? (
                <Button size="sm" variant="ghost" onClick={onOpenSettings}>
                  Configure provider
                </Button>
              ) : null}
            </div>

            {doc.providerName && hasExtraction ? (
              <p className="text-[12px] text-ink-faint">
                Extracted by {doc.providerName}
                {doc.model ? ` · ${doc.model}` : ''}
                {dirty ? ' · showing your edited version' : ''}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
