'use client';

/** Consistent empty-state panel (spec §26). */
export function EmptyState({ icon, title, children, action }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon ? <div className="text-ink-faint">{icon}</div> : null}
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {children ? <div className="max-w-sm text-sm text-ink-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
