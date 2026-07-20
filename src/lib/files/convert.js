/**
 * Blob conversion helpers. Base64 is produced only at the moment of a
 * provider request, never for storage (spec §4.2, §17).
 */
/** Blob → raw base64 payload without a data-URL prefix. */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Blob → data URL (`data:<mime>;base64,...`).
 * An explicit `mimeType` wins over `blob.type`, which is unreliable: files can
 * arrive with an empty or generic type even when the real format is known.
 */
export async function blobToDataUrl(blob, mimeType = null) {
  const type = mimeType || blob.type || 'application/octet-stream';
  return `data:${type};base64,${await blobToBase64(blob)}`;
}

export function blobToText(blob) {
  return blob.text();
}

export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
