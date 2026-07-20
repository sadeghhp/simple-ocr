import { describe, expect, it } from 'vitest';
import { PARSE_WARNINGS, parseExtractionPayload } from '@/lib/extraction/parse';

const payload = (fields = {}) =>
  JSON.stringify({
    documentType: 'invoice',
    confidence: 0.9,
    language: 'en',
    fields: { invoiceNumber: 'INV-1', total: '10.00', ...fields },
    notes: null,
    rawText: 'Invoice INV-1\nTotal 10.00',
  });

describe('parseExtractionPayload', () => {
  it('parses a clean JSON reply with no warnings', () => {
    const { data, warnings } = parseExtractionPayload(payload());
    expect(data.documentType).toBe('invoice');
    expect(data.fields.invoiceNumber).toBe('INV-1');
    expect(warnings).toEqual([]);
  });

  it('strips a markdown code fence', () => {
    const { data, warnings } = parseExtractionPayload('```json\n' + payload() + '\n```');
    expect(data.documentType).toBe('invoice');
    expect(warnings).toContain(PARSE_WARNINGS.strippedFence);
  });

  it('strips prose before and after the object', () => {
    const { data, warnings } = parseExtractionPayload(
      `Sure! Here is the extracted data:\n${payload()}\nLet me know if you need anything else.`
    );
    expect(data.fields.total).toBe('10.00');
    expect(warnings).toContain(PARSE_WARNINGS.strippedProse);
  });

  it('is not fooled by braces and quotes inside rawText', () => {
    // The naive "first { to last }" approach fails this; a page of code or a
    // form with braces is not unusual.
    const tricky = JSON.stringify({
      documentType: 'generic',
      fields: {},
      rawText: 'function f() { return "}"; } // trailing } brace',
    });
    const { data } = parseExtractionPayload(`Here you go:\n${tricky}`);
    expect(data.rawText).toBe('function f() { return "}"; } // trailing } brace');
  });

  it('handles an escaped quote immediately before the closing brace', () => {
    const tricky = JSON.stringify({ documentType: 'generic', rawText: 'ends with a quote: \\"' });
    const { data } = parseExtractionPayload(tricky);
    expect(data.rawText).toBe('ends with a quote: \\"');
  });

  it('repairs a reply truncated mid-string', () => {
    const full = payload();
    const cut = full.slice(0, full.indexOf('rawText') + 20);
    const { data, warnings } = parseExtractionPayload(cut);

    expect(warnings).toContain(PARSE_WARNINGS.repairedTruncation);
    expect(data.documentType).toBe('invoice');
    // Fields came first in the emit order precisely so they survive truncation.
    expect(data.fields.invoiceNumber).toBe('INV-1');
  });

  it('repairs a reply truncated inside a nested array', () => {
    const withItems = JSON.stringify({
      documentType: 'invoice',
      fields: {
        invoiceNumber: 'INV-9',
        lineItems: [
          { description: 'Widget', quantity: 2, amount: '4.00' },
          { description: 'Gadget', quantity: 1, amount: '9.00' },
        ],
      },
      rawText: 'long page text',
    });
    const cut = withItems.slice(0, withItems.indexOf('Gadget') + 4);
    const { data, warnings } = parseExtractionPayload(cut);

    expect(warnings).toContain(PARSE_WARNINGS.repairedTruncation);
    expect(data.fields.invoiceNumber).toBe('INV-9');
    expect(data.fields.lineItems[0].description).toBe('Widget');
  });

  it('repairs a truncated reply that was also fenced', () => {
    const full = payload();
    const cut = '```json\n' + full.slice(0, full.length - 30);
    const { data, warnings } = parseExtractionPayload(cut);
    expect(warnings).toContain(PARSE_WARNINGS.strippedFence);
    expect(data.documentType).toBe('invoice');
  });

  it('returns null data for a reply with no JSON at all', () => {
    expect(parseExtractionPayload('I cannot read this image.').data).toBeNull();
    expect(parseExtractionPayload('').data).toBeNull();
    expect(parseExtractionPayload(null).data).toBeNull();
  });

  it('rejects a bare JSON array as the top-level value', () => {
    // The contract is one object per page; an array means the model ignored it.
    expect(parseExtractionPayload('[1, 2, 3]').data).toBeNull();
  });
});
