'use client';

import { Button } from '@/components/common/Button';
import { DownloadIcon, SettingsIcon, UploadIcon } from '@/components/common/icons';
import { DocumentList } from '@/components/documents/DocumentList';
import { UploadButton } from '@/components/documents/UploadButton';
import { StorageMeter } from '@/components/layout/StorageMeter';

/**
 * Left sidebar (spec §9.1): identity, upload, document list, storage,
 * settings / export / import access.
 */
export function Sidebar({
  documents,
  childrenByParent,
  documentsLoaded,
  selectedId,
  onSelect,
  onUpload,
  onOpenSettings,
  onExport,
  onOpenImport,
  exporting,
}) {
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="border-b border-edge px-4 py-4">
        <h1 className="text-[15px] font-semibold tracking-tight text-ink">Simple OCR</h1>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Documents stay in this browser. Only OCR requests leave it.
        </p>
      </div>

      <div className="border-b border-edge p-3">
        <UploadButton onFiles={onUpload} />
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Document list">
        <DocumentList
          documents={documents}
          childrenByParent={childrenByParent}
          loaded={documentsLoaded}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </nav>

      <div className="space-y-3 border-t border-edge p-3">
        <StorageMeter refreshKey={documents.length} />
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={onExport} disabled={exporting || documents.length === 0}>
            <DownloadIcon size={14} />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
          <Button size="sm" onClick={onOpenImport}>
            <UploadIcon size={14} />
            Import
          </Button>
        </div>
        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={onOpenSettings}>
          <SettingsIcon size={14} />
          Provider settings
        </Button>
        <p className="text-center text-[11px] text-ink-faint">
          v{process.env.NEXT_PUBLIC_BUILD_VERSION}
          {process.env.NEXT_PUBLIC_BUILD_COMMIT ? ` (${process.env.NEXT_PUBLIC_BUILD_COMMIT})` : ''}
        </p>
      </div>
    </div>
  );
}
