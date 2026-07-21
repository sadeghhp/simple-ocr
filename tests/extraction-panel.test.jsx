import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExtractionPanel } from '@/components/editor/ExtractionPanel';

const saveEditedText = vi.fn().mockResolvedValue(undefined);
const saveExtractionFields = vi.fn().mockResolvedValue(undefined);
const resetEditedText = vi.fn().mockImplementation(async () => ({ extractedText: 'original text' }));
const resetExtractionFields = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/workflows', () => ({
  saveEditedText: (...args) => saveEditedText(...args),
  saveExtractionFields: (...args) => saveExtractionFields(...args),
  resetEditedText: (...args) => resetEditedText(...args),
  resetExtractionFields: (...args) => resetExtractionFields(...args),
}));

const extraction = {
  documentType: 'invoice',
  confidence: 0.9,
  language: 'en',
  fields: { invoiceNumber: 'INV-1', total: '10.00', lineItems: [] },
  extraFields: [],
  notes: null,
  rawText: 'original text',
  degraded: false,
};

const doc = (overrides = {}) => ({
  id: 'page-1',
  name: 'invoice.pdf — page 1',
  status: 'completed',
  kind: 'page',
  pageNumber: 1,
  extractedText: 'original text',
  editedText: 'original text',
  extraction,
  extractionEdited: null,
  extractionWarnings: [],
  processingError: null,
  providerName: 'Test',
  model: 'm',
  processedAt: '2026-07-20T10:00:00.000Z',
  ...overrides,
});

const renderPanel = (props = {}) =>
  render(
    <ExtractionPanel
      doc={doc()}
      providerConfigured
      processing={false}
      onProcess={vi.fn()}
      onOpenSettings={vi.fn()}
      onDocumentChanged={vi.fn()}
      {...props}
    />
  );

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('ExtractionPanel tabs', () => {
  it('opens on Fields when a structured extraction exists', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Fields' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText(/Invoice number/).value).toBe('INV-1');
  });

  it('switches to the raw text editor', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw text' }));
    expect(screen.getByRole('tabpanel').value).toBe('original text');
  });

  it('shows no tabs at all when the extraction is degraded', () => {
    // Nothing to put in a Fields tab, so offering one would be a dead end.
    renderPanel({ doc: doc({ extraction: { ...extraction, degraded: true } }) });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('Extracted text editor')).toBeTruthy();
    expect(screen.getByText(/returned text but not structured fields/)).toBeTruthy();
  });

  it('saves a field edit to extractionEdited, not to the text', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/Invoice number/), { target: { value: 'INV-2' } });

    await waitFor(() => expect(saveExtractionFields).toHaveBeenCalled());
    expect(saveExtractionFields).toHaveBeenCalledWith(
      'page-1',
      expect.objectContaining({ invoiceNumber: 'INV-2' })
    );
    // The two editors must not write over each other.
    expect(saveEditedText).not.toHaveBeenCalled();
  });

  it('saves a text edit without touching the fields', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw text' }));
    fireEvent.change(screen.getByRole('tabpanel'), { target: { value: 'corrected text' } });

    await waitFor(() => expect(saveEditedText).toHaveBeenCalledWith('page-1', 'corrected text'));
    expect(saveExtractionFields).not.toHaveBeenCalled();
  });

  it('prefers stored field edits over the model extraction', () => {
    renderPanel({
      doc: doc({ extractionEdited: { ...extraction.fields, invoiceNumber: 'EDITED' } }),
    });
    expect(screen.getByLabelText(/Invoice number/).value).toBe('EDITED');
  });

  it('resets whichever tab is showing', async () => {
    renderPanel({ doc: doc({ extractionEdited: { invoiceNumber: 'EDITED' } }) });

    fireEvent.click(screen.getByRole('button', { name: /Reset to extraction/ }));
    await waitFor(() => expect(resetExtractionFields).toHaveBeenCalledWith('page-1'));
    expect(resetEditedText).not.toHaveBeenCalled();
  });

  it('enables Reset for field edits independently of text edits', () => {
    // A pristine document offers nothing to reset...
    const { unmount } = renderPanel();
    expect(screen.getByRole('button', { name: /Reset to extraction/ }).disabled).toBe(true);
    unmount();

    // ...but an edited field enables it, even though the text is untouched.
    renderPanel({ doc: doc({ extractionEdited: { invoiceNumber: 'EDITED' } }) });
    expect(screen.getByRole('button', { name: /Reset to extraction/ }).disabled).toBe(false);
  });

  // Regression: a multi-page parent's results are written by
  // refreshParentStatus, which never sets `processedAt`. Keying the editor
  // sync on `processedAt` left the textarea empty for a document that had
  // extracted fine, and the first keystroke saved that '' over the page text.
  it('shows a multi-page parent’s text when its extraction lands without processedAt', async () => {
    const parent = (overrides = {}) =>
      doc({
        id: 'parent-1',
        name: 'invoice.pdf',
        kind: 'parent',
        pageNumber: null,
        processedAt: null,
        updatedAt: '2026-07-20T10:00:00.000Z',
        ...overrides,
      });

    // Selected before extraction finishes: no text yet.
    const { rerender } = render(
      <ExtractionPanel
        doc={parent({ status: 'processing', extractedText: null, editedText: null, extraction: null })}
        providerConfigured
        processing
        onProcess={vi.fn()}
        onOpenSettings={vi.fn()}
        onDocumentChanged={vi.fn()}
      />
    );

    // Extraction completes. Same document id, same (null) processedAt — only
    // updatedAt moves, exactly as refreshParentStatus leaves it.
    rerender(
      <ExtractionPanel
        doc={parent({
          status: 'completed',
          extractedText: '--- Page 1 ---\njoined page text',
          editedText: '--- Page 1 ---\njoined page text',
          updatedAt: '2026-07-20T10:05:00.000Z',
        })}
        providerConfigured
        processing={false}
        onProcess={vi.fn()}
        onOpenSettings={vi.fn()}
        onDocumentChanged={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Raw text' }));
    expect(screen.getByRole('tabpanel').value).toBe('--- Page 1 ---\njoined page text');
  });

  it('does not pull text out from under an edit still being typed', async () => {
    const base = doc({ updatedAt: '2026-07-20T10:00:00.000Z' });
    const { rerender } = renderPanel({ doc: base });

    fireEvent.click(screen.getByRole('tab', { name: 'Raw text' }));
    fireEvent.change(screen.getByRole('tabpanel'), { target: { value: 'user is typing' } });

    // A background refresh lands mid-edit. It must not clobber the draft.
    rerender(
      <ExtractionPanel
        doc={doc({ updatedAt: '2026-07-20T10:00:05.000Z' })}
        providerConfigured
        processing={false}
        onProcess={vi.fn()}
        onOpenSettings={vi.fn()}
        onDocumentChanged={vi.fn()}
      />
    );

    expect(screen.getByRole('tabpanel').value).toBe('user is typing');
  });

  it('offers Cancel only while processing', () => {
    const onCancel = vi.fn();
    const { unmount } = renderPanel({ onCancel });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    unmount();

    renderPanel({ onCancel, processing: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith('page-1');
  });
});
