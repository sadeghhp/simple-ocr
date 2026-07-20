'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Approximate storage usage via the Storage API (spec §16).
 * Returns `{ usage, quota, supported, refresh }`.
 */
export function useStorageEstimate(dependency) {
  const [estimate, setEstimate] = useState({ usage: null, quota: null, supported: false });

  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      setEstimate({ usage: null, quota: null, supported: false });
      return;
    }
    try {
      const { usage, quota } = await navigator.storage.estimate();
      setEstimate({ usage: usage ?? null, quota: quota ?? null, supported: true });
    } catch {
      setEstimate({ usage: null, quota: null, supported: false });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, dependency]);

  return { ...estimate, refresh };
}

/** Best-effort request for persistent storage; approval is not required (spec §16). */
export function requestPersistentStorage() {
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
}
