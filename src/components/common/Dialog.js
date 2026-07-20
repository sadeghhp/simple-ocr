'use client';

import { useCallback, useEffect, useRef } from 'react';
import { CloseIcon } from '@/components/common/icons';
import { IconButton, Button } from '@/components/common/Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: focus trap, Escape to close, focus restore
 * (spec §21). Full-screen sheet on small viewports (spec §10).
 */
export function Dialog({ open, onClose, title, children, footer, wide = false }) {
  const panelRef = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector(FOCUSABLE);
    (first || panel)?.focus();
    return () => previousFocus.current?.focus?.();
  }, [open]);

  const onKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(panelRef.current?.querySelectorAll(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[100dvh] w-full flex-col overflow-hidden bg-panel shadow-xl sm:max-h-[85dvh] sm:rounded-lg sm:border sm:border-edge ${
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md'
        }`}
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-edge px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive actions (spec §25.4). */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  confirmLabel = 'Delete',
  busy = false,
  children,
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-muted">{children}</div>
    </Dialog>
  );
}
