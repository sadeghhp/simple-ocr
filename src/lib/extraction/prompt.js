/**
 * Builds the extraction instruction from the template catalog.
 *
 * One request per page does both classification and extraction. The whole
 * catalog is ~1.5k tokens, which is cheaper than a second round trip — and it
 * lets the model pick a type and fill its fields in one coherent pass rather
 * than committing to a type before it has read the page carefully.
 */
import { FALLBACK_TEMPLATE_ID, TEMPLATES } from '@/lib/extraction/templates';

/** How each field type is described to the model. */
function describeField(field) {
  const bits = [];
  switch (field.type) {
    case 'money':
      bits.push('amount as printed, digits and separators unchanged');
      break;
    case 'number':
      bits.push('number');
      break;
    case 'date':
      bits.push('date');
      break;
    case 'boolean':
      bits.push('true or false');
      break;
    case 'enum':
      bits.push(`one of: ${field.options.join(', ')}`);
      break;
    case 'list':
      bits.push(`array${field.itemLabel ? ` of ${field.itemLabel.toLowerCase()} values` : ''}`);
      break;
    case 'table':
      bits.push(
        `array of objects with keys: ${(field.itemFields || []).map((f) => f.key).join(', ')}`
      );
      break;
    case 'text':
      bits.push('multi-line text');
      break;
    case 'string':
    default:
      bits.push('text');
      break;
  }
  if (field.required) bits.push('required');
  if (field.description) bits.push(field.description);
  if (field.example) bits.push(`e.g. "${field.example}"`);
  return `${field.key} (${bits.join('; ')})`;
}

function describeTemplate(template) {
  return `  ${template.id}: ${template.fields.map(describeField).join(', ')}`;
}

function buildPromptText() {
  const classify = TEMPLATES.map((t) => `  ${t.id} — ${t.description}`).join('\n');
  const extract = TEMPLATES.map(describeTemplate).join('\n');

  return `You read a single page image and return JSON describing it.

Step 1 — classify the page as exactly one of these types:
${classify}

Step 2 — extract the fields defined for the type you chose:
${extract}

Return a single JSON object with these keys, in this order:
  documentType  one of the type ids above
  subject       a short human title for this page, 3-8 words, or null
  confidence    number 0-1, how certain the classification is
  language      BCP-47 code of the page's main language, or null
  fields        an object holding the fields for your chosen type
  notes         anything ambiguous or unreadable, or null
  rawText       every word on the page, in natural reading order

Rules:
- Return only the JSON object. No prose before or after it, no markdown fences.
- subject names what the page *is*, using only words printed on it — the issuer,
  the counterparty, an identifying number. "Acme Corp Invoice 4471" or
  "Berlin Tenancy Agreement". No file extension, no date-only titles, no
  punctuation that cannot appear in a filename. Use null rather than inventing
  one when the page has no clear subject.
- rawText is mandatory and must be the complete text of the page, even when the
  page fits a type well. It is what the user reads and edits.
- Use null for any field you cannot find on the page. Never invent a value and
  never copy an example.
- Keep numbers, dates and identifiers exactly as printed. Do not reformat or
  convert currencies.
- If nothing matches, use "${FALLBACK_TEMPLATE_ID}" rather than forcing a poor fit.`;
}

// The catalog is static, so build once per session.
let cached = null;

/** The system prompt describing the classify-then-extract contract. */
export function buildSystemPrompt() {
  if (cached === null) cached = buildPromptText();
  return cached;
}

/**
 * System messages for one extraction request.
 *
 * The user's own OCR instruction is *appended* rather than substituted: it
 * refines how the page is read, but replacing the contract would leave the
 * response unparseable. Always a single message: some gateways forward
 * `system` turns as `user` turns for models with no native system role, and
 * two consecutive system messages would then become two consecutive user
 * turns, tripping strict user/assistant alternation checks.
 */
export function buildSystemMessages(userInstruction) {
  const extra = (userInstruction || '').trim();
  const content = extra ? `${buildSystemPrompt()}\n\nAdditional instructions:\n${extra}` : buildSystemPrompt();
  return [{ role: 'system', content }];
}

export const __testing = { describeField, describeTemplate };
