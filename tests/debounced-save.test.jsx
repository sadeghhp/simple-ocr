// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

/**
 * Harness mirroring ExtractionPanel's usage: one long-lived component whose
 * "selected record" changes underneath a pending save.
 */
function Harness({ docId }) {
  const { queue, flush, cancel } = useDebouncedSave(async (value, key) => {
    globalThis.__saves.push({ key, value });
  }, 50);
  return (
    <div>
      <button onClick={() => queue('typed-text', docId)}>queue</button>
      <button onClick={() => flush()}>flush</button>
      <button onClick={() => cancel()}>cancel</button>
    </div>
  );
}

beforeEach(() => {
  globalThis.__saves = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDebouncedSave', () => {
  it('saves against the id the edit was queued with, not the current selection', async () => {
    const { rerender } = render(<Harness docId="doc-A" />);
    await act(async () => {
      screen.getByText('queue').click();
    });

    // The user switches to another document before the debounce elapses.
    rerender(<Harness docId="doc-B" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(globalThis.__saves).toEqual([{ key: 'doc-A', value: 'typed-text' }]);
  });

  it('flush writes the pending value immediately against its own key', async () => {
    const { rerender } = render(<Harness docId="doc-A" />);
    await act(async () => {
      screen.getByText('queue').click();
    });
    rerender(<Harness docId="doc-B" />);
    await act(async () => {
      screen.getByText('flush').click();
    });
    expect(globalThis.__saves).toEqual([{ key: 'doc-A', value: 'typed-text' }]);
  });

  it('cancel drops the pending value so a reset is not overwritten', async () => {
    render(<Harness docId="doc-A" />);
    await act(async () => {
      screen.getByText('queue').click();
      screen.getByText('cancel').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(globalThis.__saves).toEqual([]);
  });

  it('coalesces rapid edits into a single write', async () => {
    render(<Harness docId="doc-A" />);
    await act(async () => {
      screen.getByText('queue').click();
      screen.getByText('queue').click();
      screen.getByText('queue').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(globalThis.__saves).toHaveLength(1);
  });

  it('flushes pending edits when the tab is hidden', async () => {
    render(<Harness docId="doc-A" />);
    await act(async () => {
      screen.getByText('queue').click();
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(globalThis.__saves).toEqual([{ key: 'doc-A', value: 'typed-text' }]);
  });
});
