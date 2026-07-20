'use client';

import { useStorageEstimate } from '@/hooks/useStorageEstimate';
import { formatBytes } from '@/lib/files/convert';

/** Approximate storage usage indicator (spec §16). */
export function StorageMeter({ refreshKey }) {
  const { usage, quota, supported } = useStorageEstimate(refreshKey);
  if (!supported || usage == null) return null;
  const percent = quota ? Math.min(100, Math.round((usage / quota) * 100)) : null;
  const low = percent != null && percent >= 85;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-ink-faint">Browser storage</span>
        <span className={low ? 'font-medium text-warning' : 'text-ink-faint'}>
          {formatBytes(usage)}
          {quota ? ` of ${formatBytes(quota)}` : ''}
        </span>
      </div>
      {percent != null ? (
        <div
          role="progressbar"
          aria-label="Storage used"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 overflow-hidden rounded-full bg-edge"
        >
          <div
            className={`h-full rounded-full ${low ? 'bg-warning' : 'bg-accent'}`}
            style={{ width: `${Math.max(percent, 2)}%` }}
          />
        </div>
      ) : null}
      {low ? (
        <p className="text-[12px] text-warning">
          Storage is nearly full. Export your data or delete documents before uploading more.
        </p>
      ) : null}
    </div>
  );
}
