'use client';

import { useEffect, useState } from 'react';
import { getFile } from '@/lib/db/files';

/**
 * Load the original file record for the selected document only (spec §17 —
 * blobs are never loaded for the list).
 */
export function useDocumentFile(fileId) {
  const [state, setState] = useState({ file: null, loading: Boolean(fileId), error: null });

  useEffect(() => {
    if (!fileId) {
      setState({ file: null, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setState({ file: null, loading: true, error: null });
    getFile(fileId)
      .then((file) => {
        if (!cancelled) setState({ file, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ file: null, loading: false, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  return state;
}
