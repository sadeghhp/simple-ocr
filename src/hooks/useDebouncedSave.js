'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const SAVE_STATE = {
  idle: 'idle',
  saving: 'saving',
  saved: 'saved',
  failed: 'failed',
};

/**
 * Debounced auto-save (spec §14.3, §17).
 *
 * The pending write carries its own target key, so a save queued for one
 * record can never be redirected to whichever record happens to be selected
 * when the timer fires. `save` is called as `save(value, key)` — it must use
 * that key rather than closing over the current selection.
 */
export function useDebouncedSave(save, delay = 800) {
  const [state, setState] = useState(SAVE_STATE.idle);
  const timer = useRef(null);
  const pending = useRef(null); // { key, value } | null
  const saveRef = useRef(save);

  useEffect(() => {
    saveRef.current = save;
  });

  const run = useCallback(async () => {
    if (pending.current === null) return;
    const { key, value } = pending.current;
    pending.current = null;
    setState(SAVE_STATE.saving);
    try {
      await saveRef.current(value, key);
      // A newer edit may have been queued while this save ran.
      setState(pending.current === null ? SAVE_STATE.saved : SAVE_STATE.saving);
    } catch {
      setState(SAVE_STATE.failed);
    }
  }, []);

  const queue = useCallback(
    (value, key) => {
      pending.current = { key, value };
      setState(SAVE_STATE.saving);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(run, delay);
    },
    [run, delay]
  );

  /** Write any pending value immediately, against the key it was queued with. */
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    return run();
  }, [run]);

  /** Drop the pending value without writing it (used when edits are discarded). */
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
  }, []);

  // Save in-flight edits when the tab is hidden or closed. `pagehide` and
  // `visibilitychange` are the only events that fire reliably on mobile;
  // unmount cleanup alone never runs on a real tab close.
  useEffect(() => {
    const onLeave = () => {
      if (pending.current !== null) flush();
    };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onLeave);
    };
  }, [flush]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      run();
    },
    [run]
  );

  /**
   * Whether an edit is queued but not yet written. Callers that re-sync an
   * editor from the database use this to avoid overwriting what the user is
   * still typing.
   */
  const isPending = useCallback(() => pending.current !== null, []);

  return { queue, flush, cancel, isPending, state, setState };
}
