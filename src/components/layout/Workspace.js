'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/Dialog';
import { CloseIcon, MenuIcon, TrashIcon, UploadIcon } from '@/components/common/icons';
import { ExtractionPanel } from '@/components/editor/ExtractionPanel';
import { ImportDialog } from '@/components/importer/ImportDialog';
import { PreviewPanel } from '@/components/preview/PreviewPanel';
import { ProviderSettingsDialog } from '@/components/provider/ProviderSettingsDialog';
import { Sidebar } from '@/components/layout/Sidebar';
import { useAppState } from '@/hooks/useAppState';
import { requestPersistentStorage } from '@/hooks/useStorageEstimate';
import { errorDetail, errorHint, userMessage, toAppError } from '@/lib/errors';
import { downloadExport } from '@/lib/export/exporter';
import { deleteAllLocalData } from '@/lib/workflows';
import { isProviderConfigured } from '@/lib/providers/validation';

function Notice({ notice, onDismiss }) {
  useEffect(() => {
    if (!notice || notice.kind === 'error') return undefined;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;
  const isError = notice.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={`pointer-events-auto fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${
        isError
          ? 'border-danger-edge bg-danger-soft text-danger'
          : 'border-success-edge bg-success-soft text-success'
      }`}
    >
      <span className="flex-1">
        {isError ? (
          <>
            {notice.fileName ? `“${notice.fileName}”: ` : ''}
            {userMessage(notice.error)}
            {errorHint(notice.error) ? (
              <span className="mt-1 block text-[13px] text-danger/85">
                {errorHint(notice.error)}
              </span>
            ) : null}
            {/* Without this the underlying DOMException is discarded, and a
                storage failure gives the user nothing to report or act on. */}
            {errorDetail(notice.error) ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[12px] text-danger/80 underline underline-offset-2">
                  Technical details
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-danger-edge/60 bg-panel/60 p-2 text-[11px] leading-relaxed text-ink-muted">
                  {errorDetail(notice.error)}
                </pre>
              </details>
            ) : null}
          </>
        ) : (
          notice.text
        )}
      </span>
      <IconButton label="Dismiss notification" onClick={onDismiss} className="-mr-1 h-6 w-6">
        <CloseIcon size={13} />
      </IconButton>
    </div>
  );
}

/**
 * Main workspace (spec §9): sidebar + preview + extraction panel on desktop;
 * drawer + Preview/Text tabs on small screens (spec §10).
 */
export function Workspace() {
  const {
    documents,
    rootDocuments,
    childrenByParent,
    documentsLoaded,
    selectedId,
    setSelectedId,
    selectedDocument,
    providerConfig,
    processingIds,
    notice,
    setNotice,
    refreshDocuments,
    upload,
    process,
    cancel,
    remove,
    saveProvider,
  } = useAppState();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState('preview');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    requestPersistentStorage();
  }, []);

  const handleUpload = useCallback(
    async (files) => {
      await upload(files);
      setDrawerOpen(false);
    },
    [upload]
  );

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const { documentCount } = await downloadExport();
      setNotice({
        kind: 'success',
        text: `Exported ${documentCount} ${documentCount === 1 ? 'document' : 'documents'}.`,
      });
    } catch (err) {
      setNotice({ kind: 'error', error: toAppError(err) });
    } finally {
      setExporting(false);
    }
  }, [setNotice]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await remove(deleteTarget.id);
      setDeleteTarget(null);
      setNotice({ kind: 'success', text: `“${deleteTarget.name}” deleted.` });
    } catch (err) {
      setNotice({ kind: 'error', error: toAppError(err) });
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, remove, setNotice]);

  const confirmDeleteAll = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteAllLocalData();
      window.location.reload();
    } catch (err) {
      setDeleting(false);
      setNotice({ kind: 'error', error: toAppError(err) });
    }
  }, [setNotice]);

  // Whole-window drag-and-drop with a visible drop target (spec §4.1).
  const onDragEnter = (event) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (event.dataTransfer?.types?.includes('Files')) setDragging(true);
  };
  const onDragLeave = (event) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer?.files?.length) handleUpload(event.dataTransfer.files);
  };

  const providerConfigured = isProviderConfigured(providerConfig);
  const processing = selectedDocument ? processingIds.has(selectedDocument.id) : false;

  return (
    <div
      className="flex h-dvh flex-col"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Mobile top bar */}
      <header className="flex items-center gap-2 border-b border-edge bg-panel px-3 py-2 lg:hidden">
        <IconButton label="Open document list" onClick={() => setDrawerOpen(true)}>
          <MenuIcon />
        </IconButton>
        <span className="text-sm font-semibold text-ink">Simple OCR</span>
        {selectedDocument ? (
          <div className="ml-auto flex rounded-md border border-edge p-0.5" role="tablist" aria-label="Panels">
            {['preview', 'text'].map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={mobileTab === tab}
                onClick={() => setMobileTab(tab)}
                className={`rounded px-3 py-1 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${
                  mobileTab === tab ? 'bg-accent-soft text-accent' : 'text-ink-muted'
                }`}
              >
                {tab === 'preview' ? 'Preview' : 'Text'}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar: fixed column on desktop, drawer on mobile */}
        <aside className="hidden w-72 shrink-0 border-r border-edge lg:block">
          <Sidebar
            documents={rootDocuments}
            childrenByParent={childrenByParent}
            documentsLoaded={documentsLoaded}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onUpload={handleUpload}
            onOpenSettings={() => setSettingsOpen(true)}
            onExport={handleExport}
            onOpenImport={() => setImportOpen(true)}
            exporting={exporting}
          />
        </aside>

        {drawerOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-ink/40"
              aria-hidden="true"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-80 max-w-[85vw] border-r border-edge shadow-xl">
              <div className="absolute right-2 top-3 z-10">
                <IconButton label="Close document list" onClick={() => setDrawerOpen(false)}>
                  <CloseIcon />
                </IconButton>
              </div>
              <Sidebar
                documents={rootDocuments}
                childrenByParent={childrenByParent}
                documentsLoaded={documentsLoaded}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setDrawerOpen(false);
                }}
                onUpload={handleUpload}
                onOpenSettings={() => {
                  setDrawerOpen(false);
                  setSettingsOpen(true);
                }}
                onExport={handleExport}
                onOpenImport={() => {
                  setDrawerOpen(false);
                  setImportOpen(true);
                }}
                exporting={exporting}
              />
            </div>
          </div>
        ) : null}

        {/* Preview */}
        <main
          className={`min-h-0 min-w-0 flex-1 ${mobileTab === 'preview' ? 'block' : 'hidden'} lg:block`}
        >
          <div className="relative h-full">
            <PreviewPanel doc={selectedDocument} />
            {selectedDocument ? (
              <div className="absolute right-3 top-2.5">
                <IconButton
                  label={`Delete ${selectedDocument.name}`}
                  onClick={() => setDeleteTarget(selectedDocument)}
                >
                  <TrashIcon size={15} />
                </IconButton>
              </div>
            ) : null}
          </div>
        </main>

        {/* Extraction panel */}
        <section
          aria-label="Extracted text"
          className={`min-h-0 w-full border-l border-edge lg:w-[26rem] lg:shrink-0 xl:w-[30rem] ${
            mobileTab === 'text' ? 'block' : 'hidden'
          } lg:block`}
        >
          <ExtractionPanel
            doc={selectedDocument}
            providerConfigured={providerConfigured}
            processing={processing}
            onProcess={process}
            onCancel={cancel}
            onOpenSettings={() => setSettingsOpen(true)}
            onDocumentChanged={refreshDocuments}
          />
        </section>
      </div>

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent-soft/80">
          <div className="flex items-center gap-3 rounded-lg border-2 border-dashed border-accent bg-panel px-6 py-4 text-sm font-medium text-accent">
            <UploadIcon size={18} />
            Drop files to store them in your browser
          </div>
        </div>
      ) : null}

      <ProviderSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={providerConfig}
        onSave={saveProvider}
        onDeleteAllData={() => {
          setSettingsOpen(false);
          setDeleteAllOpen(true);
        }}
      />

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async (count) => {
          await refreshDocuments();
          setNotice({
            kind: 'success',
            text: `Imported ${count} ${count === 1 ? 'document' : 'documents'}.`,
          });
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete document?"
        busy={deleting}
      >
        <p>
          <span className="font-medium text-ink">“{deleteTarget?.name}”</span> and its extracted
          text will be permanently removed from this browser. This cannot be undone.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteAllOpen}
        onCancel={() => setDeleteAllOpen(false)}
        onConfirm={confirmDeleteAll}
        title="Delete all local data?"
        confirmLabel="Delete everything"
        busy={deleting}
      >
        <p>
          Every document, original file, extraction result, and setting stored by Simple OCR in
          this browser will be permanently removed. Consider exporting first. This cannot be
          undone.
        </p>
      </ConfirmDialog>

      <Notice notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
