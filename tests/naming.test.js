import { describe, expect, it } from 'vitest';
import {
  deriveDocumentName,
  extensionOf,
  pageDisplayName,
  sanitizeDocumentName,
} from '@/lib/naming';

// A model reply reaches the filesystem-shaped parts of the app (the export
// manifest, the sidebar, a download name), so these cases are the trust
// boundary rather than cosmetic tidying.
describe('sanitizeDocumentName', () => {
  it('collapses whitespace and trims', () => {
    expect(sanitizeDocumentName('  Acme   Corp\n\tInvoice  ')).toBe('Acme Corp Invoice');
  });

  it('strips path separators so a subject can never become a path', () => {
    expect(sanitizeDocumentName('../../etc/passwd')).toBe('.. .. etc passwd');
    expect(sanitizeDocumentName('a\\b/c')).toBe('a b c');
  });

  it('strips control characters', () => {
    const withControls = `Bad${String.fromCharCode(7)}Name${String.fromCharCode(0)}`;
    expect(sanitizeDocumentName(withControls)).toBe('Bad Name');
  });

  it('returns null when nothing usable survives', () => {
    expect(sanitizeDocumentName('')).toBeNull();
    expect(sanitizeDocumentName('   ')).toBeNull();
    expect(sanitizeDocumentName('///')).toBeNull();
    expect(sanitizeDocumentName(null)).toBeNull();
    expect(sanitizeDocumentName(42)).toBeNull();
  });

  it('cuts a long name on a word boundary', () => {
    const long = 'word '.repeat(40).trim();
    const result = sanitizeDocumentName(long);
    expect(result.length).toBeLessThanOrEqual(80);
    // Cut between words, so no half-word and no trailing space.
    expect(result.endsWith('word')).toBe(true);
  });

  it('hard-cuts a single very long token rather than dropping it', () => {
    const result = sanitizeDocumentName('x'.repeat(200));
    expect(result).toBe('x'.repeat(80));
  });
});

describe('extensionOf', () => {
  it('returns the extension including the dot', () => {
    expect(extensionOf('scan_0012.pdf')).toBe('.pdf');
    expect(extensionOf('a.b.jpeg')).toBe('.jpeg');
  });

  it('returns empty for hidden files, missing and implausible extensions', () => {
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('no-extension')).toBe('');
    // Longer than any real extension, so it is prose rather than a suffix.
    expect(extensionOf('report.attachment')).toBe('');
    expect(extensionOf('a b.not an ext')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});

describe('deriveDocumentName', () => {
  it('carries the original extension over', () => {
    expect(deriveDocumentName('Acme Corp Invoice 4471', 'scan_0012.pdf')).toBe(
      'Acme Corp Invoice 4471.pdf'
    );
  });

  it('does not double the extension when the subject already ends in it', () => {
    expect(deriveDocumentName('Quarterly Report.pdf', 'scan.pdf')).toBe('Quarterly Report.pdf');
  });

  it('returns null for an unusable subject, meaning do not rename', () => {
    expect(deriveDocumentName(null, 'scan.pdf')).toBeNull();
    expect(deriveDocumentName('  ', 'scan.pdf')).toBeNull();
  });

  it('works when the original has no extension', () => {
    expect(deriveDocumentName('Meeting Notes', 'untitled')).toBe('Meeting Notes');
  });
});

describe('pageDisplayName', () => {
  it('derives a page name from its parent', () => {
    expect(pageDisplayName('Acme Invoice.pdf', 3)).toBe('Acme Invoice.pdf — page 3');
  });
});
