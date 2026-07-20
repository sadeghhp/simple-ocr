/**
 * Normalizes a parsed model reply into the stored extraction shape.
 *
 * This module NEVER throws. A model that returns a number where the template
 * says money, or invents a field nobody asked for, has still done useful work —
 * coercion records a warning and keeps going. Rejecting the whole page over a
 * type mismatch would throw away a good OCR result.
 */
import {
  FALLBACK_TEMPLATE_ID,
  getTemplate,
  isKnownTemplate,
} from '@/lib/extraction/templates';

export const COERCE_WARNINGS = {
  unknownType: 'unknown_document_type',
  missingRawText: 'missing_raw_text',
  extraFields: 'model_returned_extra_fields',
  coercedType: 'coerced_field_type',
  missingRequired: 'missing_required_field',
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function coerceScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** One field, coerced to the shape its template declares. */
function coerceField(field, value, warnings) {
  if (value === null || value === undefined) return null;

  switch (field.type) {
    case 'number':
    case 'money':
    case 'date':
    case 'string':
    case 'text': {
      // Everything scalar is stored as a string: the template says how to read
      // it, and reformatting a printed amount or date loses information.
      if (isPlainObject(value) || Array.isArray(value)) {
        warnings.push(`${COERCE_WARNINGS.coercedType}:${field.key}`);
        return null;
      }
      if (typeof value !== 'string' && value !== null) {
        warnings.push(`${COERCE_WARNINGS.coercedType}:${field.key}`);
      }
      return coerceScalar(value);
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === 'yes') return true;
        if (v === 'false' || v === 'no') return false;
      }
      warnings.push(`${COERCE_WARNINGS.coercedType}:${field.key}`);
      return null;
    }

    case 'enum': {
      const scalar = coerceScalar(value);
      if (scalar === null) return null;
      const match = (field.options || []).find(
        (option) => option.toLowerCase() === scalar.toLowerCase()
      );
      if (!match) {
        warnings.push(`${COERCE_WARNINGS.coercedType}:${field.key}`);
        return null;
      }
      return match;
    }

    case 'list': {
      if (!Array.isArray(value)) {
        warnings.push(`${COERCE_WARNINGS.coercedType}:${field.key}`);
        return [];
      }
      // Rows of a table-as-list stay arrays; everything else becomes scalar.
      return value.map((entry) =>
        Array.isArray(entry) ? entry.map(coerceScalar) : coerceScalar(entry)
      );
    }

    case 'table': {
      if (!Array.isArray(value)) {
        warnings.push(`${COERCE_WARNINGS.coercedType}:${field.key}`);
        return [];
      }
      const itemFields = field.itemFields || [];
      return value.filter(isPlainObject).map((row) => {
        const out = {};
        for (const item of itemFields) out[item.key] = coerceScalar(row[item.key]);
        return out;
      });
    }

    default:
      return coerceScalar(value);
  }
}

/**
 * Coerce a parsed reply into the stored extraction record.
 *
 * @param {object|null} raw parsed JSON from parseExtractionPayload
 * @param {object} [options]
 * @param {string} [options.fallbackText] used as rawText when the model omitted it
 * @returns {{ extraction: object, warnings: string[] }}
 */
export function coerceExtraction(raw, { fallbackText = null } = {}) {
  const warnings = [];
  const source = isPlainObject(raw) ? raw : {};

  let documentType = coerceScalar(source.documentType);
  if (!documentType || !isKnownTemplate(documentType)) {
    if (documentType) warnings.push(`${COERCE_WARNINGS.unknownType}:${documentType}`);
    documentType = FALLBACK_TEMPLATE_ID;
  }
  const template = getTemplate(documentType);

  const rawFields = isPlainObject(source.fields) ? source.fields : {};
  const fields = {};
  for (const field of template.fields) {
    fields[field.key] = coerceField(field, rawFields[field.key], warnings);
    if (field.required && (fields[field.key] === null || fields[field.key] === '')) {
      warnings.push(`${COERCE_WARNINGS.missingRequired}:${field.key}`);
    }
  }

  // Anything the model volunteered that the template does not define is kept
  // rather than dropped — it is often the most interesting thing on the page.
  const known = new Set(template.fields.map((f) => f.key));
  const extraFields = Object.entries(rawFields)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => ({
      key,
      value: Array.isArray(value) || isPlainObject(value) ? JSON.stringify(value) : coerceScalar(value),
    }));
  if (extraFields.length > 0) warnings.push(COERCE_WARNINGS.extraFields);

  let rawText = typeof source.rawText === 'string' ? source.rawText : null;
  if (rawText === null || rawText.trim() === '') {
    rawText = fallbackText;
    warnings.push(COERCE_WARNINGS.missingRawText);
  }

  const confidence =
    typeof source.confidence === 'number' && Number.isFinite(source.confidence)
      ? Math.min(1, Math.max(0, source.confidence))
      : null;

  return {
    extraction: {
      documentType,
      confidence,
      language: coerceScalar(source.language),
      fields,
      extraFields,
      notes: coerceScalar(source.notes),
      rawText: rawText ?? '',
      degraded: false,
    },
    warnings,
  };
}

/**
 * The extraction used when the reply could not be parsed as JSON at all.
 * The full reply is preserved as rawText: the user keeps their text and can
 * retry for structure, which is strictly better than showing them an error.
 */
export function degradedExtraction(text) {
  return {
    documentType: FALLBACK_TEMPLATE_ID,
    confidence: null,
    language: null,
    fields: {},
    extraFields: [],
    notes: null,
    rawText: typeof text === 'string' ? text : '',
    degraded: true,
  };
}
