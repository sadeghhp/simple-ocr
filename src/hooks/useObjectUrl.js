'use client';

import { useEffect, useState } from 'react';

/**
 * Create an object URL for a blob and revoke it when the blob changes or the
 * component unmounts (spec §4.8: avoid leaking object URLs).
 */
export function useObjectUrl(blob) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return url;
}
