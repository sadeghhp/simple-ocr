import { describe, expect, it } from 'vitest';
import {
  FIELD_TYPES,
  TEMPLATES,
  TEMPLATE_IDS,
  getTemplate,
  isKnownTemplate,
} from '@/lib/extraction/templates';
import { buildSystemPrompt, buildSystemMessages, __testing } from '@/lib/extraction/prompt';
import { COERCE_WARNINGS, coerceExtraction, degradedExtraction } from '@/lib/extraction/coerce';

/**
 * Every field declared anywhere in the catalog. Nested table row fields carry
 * `parent` so a test can reach them through the table that contains them —
 * some types (number) only ever appear nested.
 */
function allFields() {
  const out = [];
  for (const template of TEMPLATES) {
    for (const field of template.fields) {
      out.push({ template: template.id, field, parent: null });
      for (const item of field.itemFields || []) {
        out.push({ template: template.id, field: item, parent: field });
      }
    }
  }
  return out;
}

describe('template catalog integrity', () => {
  it('has unique ids and a generic fallback', () => {
    expect(new Set(TEMPLATE_IDS).size).toBe(TEMPLATE_IDS.length);
    expect(TEMPLATE_IDS).toContain('generic');
    expect(getTemplate('nonexistent-type').id).toBe('generic');
    expect(isKnownTemplate('invoice')).toBe(true);
    expect(isKnownTemplate('nope')).toBe(false);
  });

  it('declares only known field types, with unique keys per template', () => {
    for (const { template, field } of allFields()) {
      expect(FIELD_TYPES, `${template}.${field.key} uses an undeclared type`).toContain(field.type);
      expect(field.key).toBeTruthy();
      expect(field.label).toBeTruthy();
    }
    for (const template of TEMPLATES) {
      const keys = template.fields.map((f) => f.key);
      expect(new Set(keys).size, `${template.id} has duplicate field keys`).toBe(keys.length);
    }
  });

  it('gives every enum options and every table row fields', () => {
    for (const { template, field } of allFields()) {
      if (field.type === 'enum') {
        expect(field.options?.length, `${template}.${field.key}`).toBeGreaterThan(0);
      }
      if (field.type === 'table') {
        expect(field.itemFields?.length, `${template}.${field.key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('every field type is handled by every consumer', () => {
  // The catalog is only safe to extend if all three consumers move together.
  // Consumer 3 (FieldEditor) joins this assertion when the UI lands.
  const usedTypes = [...new Set(allFields().map(({ field }) => field.type))];

  it.each(usedTypes)('prompt.js describes type "%s"', (type) => {
    const sample = allFields().find(({ field }) => field.type === type).field;
    const described = __testing.describeField(sample);
    expect(described).toContain(sample.key);
    // A type that fell through to the default would not mention anything
    // type-specific; require a real clause beyond the bare key.
    expect(described.length).toBeGreaterThan(sample.key.length + 2);
  });

  it.each(usedTypes)('coerce.js has a rule for type "%s"', (type) => {
    const { template, field, parent } = allFields().find((entry) => entry.field.type === type);

    if (parent) {
      // Reached through its table: a row must come back with the key present.
      const { extraction } = coerceExtraction({
        documentType: template,
        fields: { [parent.key]: [{ [field.key]: 'v' }] },
        rawText: 'x',
      });
      expect(extraction.fields[parent.key][0]).toHaveProperty(field.key, 'v');
      return;
    }

    const { extraction } = coerceExtraction({
      documentType: template,
      fields: { [field.key]: null },
      rawText: 'x',
    });
    // Tables and lists coerce to arrays, scalars to null — never undefined,
    // which is what a missing switch arm would produce.
    if (field.type === 'table' || field.type === 'list') {
      expect(extraction.fields[field.key] ?? []).toEqual([]);
    } else {
      expect(extraction.fields).toHaveProperty(field.key);
    }
  });
});

describe('buildSystemPrompt', () => {
  it('names every template and its fields, and demands rawText', () => {
    const prompt = buildSystemPrompt();
    for (const template of TEMPLATES) {
      expect(prompt).toContain(template.id);
      expect(prompt).toContain(template.description);
    }
    expect(prompt).toContain('invoiceNumber');
    expect(prompt).toContain('rawText');
    // json_object mode requires the literal word; also keeps non-strict models honest.
    expect(prompt).toContain('JSON');
  });

  it('emits fields before rawText so truncation costs text, not structure', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.indexOf('  fields')).toBeLessThan(prompt.indexOf('  rawText'));
  });

  it('appends the user instruction instead of replacing the contract, in a single system message', () => {
    const messages = buildSystemMessages('Prefer Farsi transliteration.');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('documentType');
    expect(messages[0].content).toContain('Prefer Farsi transliteration.');

    expect(buildSystemMessages('   ')).toHaveLength(1);
    expect(buildSystemMessages(null)).toHaveLength(1);
  });
});

describe('coerceExtraction', () => {
  it('normalizes a well-formed invoice reply', () => {
    const { extraction, warnings } = coerceExtraction({
      documentType: 'invoice',
      confidence: 0.87,
      language: 'en',
      fields: {
        invoiceNumber: 'INV-2291',
        total: '1240.00',
        lineItems: [{ description: 'Widget', quantity: 2, unitPrice: '10', amount: '20' }],
      },
      rawText: 'Invoice INV-2291',
    });

    expect(extraction.documentType).toBe('invoice');
    expect(extraction.confidence).toBe(0.87);
    expect(extraction.fields.invoiceNumber).toBe('INV-2291');
    expect(extraction.fields.lineItems[0].quantity).toBe('2');
    // Declared-but-absent fields are present as null, so the editor can render
    // an empty input rather than skipping the row entirely.
    expect(extraction.fields.dueDate).toBeNull();
    expect(extraction.degraded).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('falls back to generic for an unknown document type', () => {
    const { extraction, warnings } = coerceExtraction({
      documentType: 'shipping_manifest',
      fields: { anything: 'here' },
      rawText: 'text',
    });
    expect(extraction.documentType).toBe('generic');
    expect(warnings.some((w) => w.startsWith(COERCE_WARNINGS.unknownType))).toBe(true);
  });

  it('keeps fields the model invented rather than dropping them', () => {
    const { extraction, warnings } = coerceExtraction({
      documentType: 'invoice',
      fields: { invoiceNumber: 'INV-1', purchaseOrderRef: 'PO-77' },
      rawText: 'text',
    });
    expect(extraction.extraFields).toContainEqual({ key: 'purchaseOrderRef', value: 'PO-77' });
    expect(warnings).toContain(COERCE_WARNINGS.extraFields);
  });

  it('coerces mismatched scalar types instead of rejecting the page', () => {
    const { extraction, warnings } = coerceExtraction({
      documentType: 'invoice',
      fields: { invoiceNumber: 4021, total: { amount: 12 } },
      rawText: 'text',
    });
    expect(extraction.fields.invoiceNumber).toBe('4021');
    expect(extraction.fields.total).toBeNull();
    expect(warnings.some((w) => w.startsWith(COERCE_WARNINGS.coercedType))).toBe(true);
  });

  it('matches an enum case-insensitively and drops an invalid option', () => {
    const ok = coerceExtraction({
      documentType: 'id_card',
      fields: { documentKind: 'PASSPORT' },
      rawText: 't',
    });
    expect(ok.extraction.fields.documentKind).toBe('passport');

    const bad = coerceExtraction({
      documentType: 'id_card',
      fields: { documentKind: 'library_card' },
      rawText: 't',
    });
    expect(bad.extraction.fields.documentKind).toBeNull();
  });

  it('flags a missing required field without failing', () => {
    const { extraction, warnings } = coerceExtraction({
      documentType: 'invoice',
      fields: { invoiceNumber: 'INV-1' },
      rawText: 'text',
    });
    expect(extraction.fields.invoiceNumber).toBe('INV-1');
    expect(warnings).toContain(`${COERCE_WARNINGS.missingRequired}:total`);
  });

  it('falls back to the raw reply when the model omitted rawText', () => {
    const { extraction, warnings } = coerceExtraction(
      { documentType: 'invoice', fields: {} },
      { fallbackText: 'the original reply' }
    );
    expect(extraction.rawText).toBe('the original reply');
    expect(warnings).toContain(COERCE_WARNINGS.missingRawText);
  });

  it('never throws on hostile input', () => {
    for (const input of [null, undefined, 'a string', 42, [], { fields: 'not an object' }]) {
      expect(() => coerceExtraction(input)).not.toThrow();
      expect(coerceExtraction(input).extraction.documentType).toBe('generic');
    }
  });

  it('preserves the whole reply in a degraded extraction', () => {
    const degraded = degradedExtraction('model said something unparseable');
    expect(degraded.rawText).toBe('model said something unparseable');
    expect(degraded.degraded).toBe(true);
    expect(degraded.documentType).toBe('generic');
  });
});
