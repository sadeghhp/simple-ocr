import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DocumentList } from '@/components/documents/DocumentList';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { FieldEditor } from '@/components/extraction/FieldEditor';

afterEach(cleanup);

const parent = {
  id: 'parent-1',
  name: 'invoices.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  createdAt: '2026-07-20T10:00:00.000Z',
  status: 'partial',
  kind: 'parent',
  pageCount: 3,
};

const page = (n, status, documentType = null) => ({
  id: `page-${n}`,
  parentId: 'parent-1',
  pageNumber: n,
  name: `invoices.pdf — page ${n}`,
  mimeType: 'application/pdf',
  status,
  kind: 'page',
  documentType,
});

const pages = [page(1, 'completed', 'invoice'), page(2, 'failed'), page(3, 'completed', 'receipt')];

const renderTree = (props = {}) =>
  render(
    <DocumentList
      documents={[parent]}
      childrenByParent={new Map([['parent-1', pages]])}
      loaded
      selectedId={null}
      onSelect={() => {}}
      {...props}
    />
  );

describe('DocumentList tree', () => {
  it('shows one row per upload, with pages hidden until expanded', () => {
    renderTree();

    expect(screen.getByText('invoices.pdf')).toBeTruthy();
    // A 3-page PDF must not flood the sidebar with 4 rows.
    expect(screen.queryByText('Page 1 · invoice')).toBeNull();
    expect(screen.getByRole('button', { name: /Expand pages of invoices\.pdf/ })).toBeTruthy();
  });

  it('reveals the pages when expanded, in page order', () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /Expand pages/ }));

    const list = screen.getByRole('list', { name: 'Pages of invoices.pdf' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Page 1');
    expect(items[2].textContent).toContain('Page 3');
    // Detected type is surfaced on the row so a batch can be scanned at a glance.
    expect(items[0].textContent).toContain('invoice');
  });

  it('toggles aria-expanded for assistive technology', () => {
    renderTree();
    const toggle = screen.getByRole('button', { name: /Expand pages/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: /Collapse pages/ }).getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('auto-expands when a page is selected from elsewhere', () => {
    // Retrying a failed page selects it; the tree must reveal it rather than
    // leaving the selection invisible inside a collapsed parent.
    renderTree({ selectedId: 'page-2' });
    expect(screen.getByRole('list', { name: 'Pages of invoices.pdf' })).toBeTruthy();
  });

  it('selects a page by its own id, not the parent', () => {
    const onSelect = vi.fn();
    renderTree({ onSelect });
    fireEvent.click(screen.getByRole('button', { name: /Expand pages/ }));
    fireEvent.click(screen.getByText('Page 3 · receipt'));

    expect(onSelect).toHaveBeenCalledWith('page-3');
  });

  it('renders a document with no pages without a toggle', () => {
    render(
      <DocumentList
        documents={[{ ...parent, id: 'solo', name: 'scan.png', kind: 'single', status: 'ready' }]}
        childrenByParent={new Map()}
        loaded
        selectedId={null}
        onSelect={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: /Expand pages/ })).toBeNull();
  });
});

describe('StatusBadge page progress', () => {
  it('reports how many pages survived instead of a bare status', () => {
    // "Failed" on a 40-page document tells the user nothing useful.
    render(<StatusBadge status="partial" pages={{ total: 40, completed: 38, failed: 2 }} />);
    expect(screen.getByText('38 of 40 pages')).toBeTruthy();
  });

  it('counts progress while processing', () => {
    render(<StatusBadge status="processing" pages={{ total: 10, completed: 3, failed: 0 }} />);
    expect(screen.getByText('Page 4 of 10…')).toBeTruthy();
  });

  it('falls back to a plain label with no page data', () => {
    render(<StatusBadge status="partial" />);
    expect(screen.getByText('Some pages failed')).toBeTruthy();
  });
});

describe('FieldEditor', () => {
  const extraction = {
    documentType: 'invoice',
    confidence: 0.86,
    language: 'en',
    fields: {
      invoiceNumber: 'INV-2291',
      total: '1240.00',
      lineItems: [{ description: 'Widget', quantity: '2', unitPrice: '10', amount: '20' }],
    },
    extraFields: [{ key: 'purchaseOrderRef', value: 'PO-77' }],
    notes: 'Stamp partially illegible.',
    rawText: 'Invoice INV-2291',
    degraded: false,
  };

  it('renders the template label, confidence, and field values', () => {
    render(<FieldEditor extraction={extraction} onChange={() => {}} />);

    expect(screen.getByText('Invoice')).toBeTruthy();
    expect(screen.getByText('86% confident')).toBeTruthy();
    expect(screen.getByLabelText(/Invoice number/).value).toBe('INV-2291');
    expect(screen.getByLabelText(/^Total/).value).toBe('1240.00');
  });

  it('renders a table field as editable rows', () => {
    render(<FieldEditor extraction={extraction} onChange={() => {}} />);
    expect(screen.getByLabelText('Line items row 1 Description').value).toBe('Widget');
    expect(screen.getByLabelText('Line items row 1 Qty').value).toBe('2');
  });

  it('reports an edited field as the full field map', () => {
    const onChange = vi.fn();
    render(<FieldEditor extraction={extraction} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/Invoice number/), { target: { value: 'INV-9' } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceNumber: 'INV-9', total: '1240.00' })
    );
  });

  it('surfaces fields the model invented rather than dropping them', () => {
    render(<FieldEditor extraction={extraction} onChange={() => {}} />);
    expect(screen.getByText('purchaseOrderRef')).toBeTruthy();
    expect(screen.getByText('PO-77')).toBeTruthy();
  });

  it('shows model notes when present', () => {
    render(<FieldEditor extraction={extraction} onChange={() => {}} />);
    expect(screen.getByText(/Stamp partially illegible/)).toBeTruthy();
  });

  it('disables every input while processing', () => {
    render(<FieldEditor extraction={extraction} onChange={() => {}} disabled />);
    // Fields are disabled via their wrapping <fieldset>, which is what actually
    // bars interaction in a browser. `input.disabled` reflects only the input's
    // own attribute and stays false here, so assert the real mechanism.
    const input = screen.getByLabelText(/Invoice number/);
    expect(input.closest('fieldset').disabled).toBe(true);
    expect(input.matches(':disabled')).toBe(true);
  });

  it('renders an unknown document type against the generic template', () => {
    render(
      <FieldEditor
        extraction={{ ...extraction, documentType: 'not_a_real_type', fields: {} }}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('Other')).toBeTruthy();
  });
});
