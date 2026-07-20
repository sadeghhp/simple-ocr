/**
 * Settings store: key/value records (spec §7.3).
 * Provider credentials live only here and are never exported by default.
 */
import { STORES, requestToPromise, withTransaction } from '@/lib/db/database';

export const SETTINGS_KEYS = {
  provider: 'provider',
  uiPrefs: 'uiPrefs',
};

export async function getSetting(key) {
  const record = await withTransaction([STORES.settings], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORES.settings).get(key))
  );
  return record ? record.value : null;
}

export function setSetting(key, value) {
  return withTransaction([STORES.settings], 'readwrite', (tx) =>
    requestToPromise(
      tx.objectStore(STORES.settings).put({ key, value, updatedAt: new Date().toISOString() })
    )
  );
}

export function deleteSetting(key) {
  return withTransaction([STORES.settings], 'readwrite', (tx) =>
    requestToPromise(tx.objectStore(STORES.settings).delete(key))
  );
}
