/**
 * Built-in document type catalog.
 *
 * ONE structure drives three consumers, and that is the point:
 *   - prompt.js       turns a template into instruction text
 *   - coerce.js       validates and normalizes the model's reply against it
 *   - FieldEditor.js  renders an input per field
 *
 * The contract that makes one structure sufficient: every `type` below has a
 * defined prompt phrasing, a defined coercion, and a defined input widget.
 * `tests/extraction-templates.test.js` asserts all three stay in sync — adding
 * a field type without handling it everywhere is meant to fail loudly.
 */

/**
 * @typedef {Object} TemplateField
 * @property {string} key           stable camelCase JSON key
 * @property {string} label         UI label
 * @property {FieldType} type
 * @property {string} [description] one clause, copied verbatim into the prompt
 * @property {string} [example]     input placeholder and prompt example
 * @property {boolean} [required]   affects validation severity only, never throws
 * @property {string[]} [options]   for type 'enum'
 * @property {TemplateField[]} [itemFields] for type 'table' — the row shape
 * @property {string} [itemLabel]   for type 'list' — label for one entry
 */

/** Every field type the catalog is allowed to use. */
export const FIELD_TYPES = [
  'string',
  'text',
  'number',
  'money',
  'date',
  'boolean',
  'enum',
  'list',
  'table',
];

const money = (key, label, extra = {}) => ({ key, label, type: 'money', ...extra });
const str = (key, label, extra = {}) => ({ key, label, type: 'string', ...extra });
const date = (key, label, extra = {}) => ({
  key,
  label,
  type: 'date',
  description: 'ISO 8601 (YYYY-MM-DD) if the date can be determined.',
  ...extra,
});

/**
 * `entries` is how a document with unpredictable fields stays structured
 * without an infinite catalog: every visible label/value pair becomes a row.
 */
const entriesField = {
  key: 'entries',
  label: 'Fields',
  type: 'table',
  description: 'Every labelled value visible on the page, in reading order.',
  itemFields: [
    { key: 'label', label: 'Label', type: 'string' },
    { key: 'value', label: 'Value', type: 'string' },
  ],
};

export const TEMPLATES = [
  {
    id: 'invoice',
    label: 'Invoice',
    description: 'A bill issued by a seller requesting payment, with line items and a total due.',
    fields: [
      str('invoiceNumber', 'Invoice number', { required: true, example: 'INV-2024-0031' }),
      date('issueDate', 'Issue date'),
      date('dueDate', 'Due date'),
      str('sellerName', 'Seller'),
      str('buyerName', 'Buyer'),
      str('currency', 'Currency', { description: 'ISO 4217 code such as USD or EUR.' }),
      money('subtotal', 'Subtotal'),
      money('taxTotal', 'Tax'),
      money('total', 'Total', { required: true }),
      {
        key: 'lineItems',
        label: 'Line items',
        type: 'table',
        itemFields: [
          { key: 'description', label: 'Description', type: 'string' },
          { key: 'quantity', label: 'Qty', type: 'number' },
          { key: 'unitPrice', label: 'Unit price', type: 'money' },
          { key: 'amount', label: 'Amount', type: 'money' },
        ],
      },
    ],
  },
  {
    id: 'receipt',
    label: 'Receipt',
    description: 'Proof of a completed purchase, usually from a shop or restaurant till.',
    fields: [
      str('merchantName', 'Merchant', { required: true }),
      date('purchaseDate', 'Date'),
      str('purchaseTime', 'Time', { example: '14:32' }),
      str('currency', 'Currency'),
      money('subtotal', 'Subtotal'),
      money('taxTotal', 'Tax'),
      money('total', 'Total', { required: true }),
      str('paymentMethod', 'Payment method', { example: 'Visa ending 4242' }),
      {
        key: 'lineItems',
        label: 'Items',
        type: 'table',
        itemFields: [
          { key: 'description', label: 'Item', type: 'string' },
          { key: 'quantity', label: 'Qty', type: 'number' },
          { key: 'amount', label: 'Amount', type: 'money' },
        ],
      },
    ],
  },
  {
    id: 'id_card',
    label: 'ID document',
    description:
      'A government or institutional identity document: passport, driving licence, national ID, residence permit.',
    fields: [
      {
        key: 'documentKind',
        label: 'Document kind',
        type: 'enum',
        options: ['passport', 'driving_licence', 'national_id', 'residence_permit', 'other'],
      },
      str('fullName', 'Full name', { required: true }),
      str('documentNumber', 'Document number', { required: true }),
      str('nationality', 'Nationality'),
      date('dateOfBirth', 'Date of birth'),
      date('issueDate', 'Issue date'),
      date('expiryDate', 'Expiry date'),
      str('issuingAuthority', 'Issuing authority'),
      { key: 'sex', label: 'Sex', type: 'enum', options: ['F', 'M', 'X', 'unspecified'] },
    ],
  },
  {
    id: 'business_card',
    label: 'Business card',
    description: 'A contact card carrying a person’s name, role and contact details.',
    fields: [
      str('fullName', 'Full name', { required: true }),
      str('jobTitle', 'Job title'),
      str('organization', 'Organization'),
      str('email', 'Email'),
      str('phone', 'Phone'),
      str('website', 'Website'),
      { key: 'address', label: 'Address', type: 'text' },
    ],
  },
  {
    id: 'form',
    label: 'Form',
    description:
      'A filled-in form or application whose fields are specific to that form and not known in advance.',
    fields: [
      str('formTitle', 'Form title'),
      str('referenceNumber', 'Reference number'),
      date('formDate', 'Date'),
      entriesField,
    ],
  },
  {
    id: 'letter',
    label: 'Letter',
    description: 'Correspondence: a letter, memo, notice or email printout.',
    fields: [
      str('sender', 'From'),
      str('recipient', 'To'),
      date('letterDate', 'Date'),
      str('subject', 'Subject'),
      { key: 'body', label: 'Body', type: 'text' },
    ],
  },
  {
    id: 'table',
    label: 'Table',
    description:
      'A page that is predominantly one tabular dataset: a statement, ledger, price list or spreadsheet print.',
    fields: [
      str('title', 'Title'),
      {
        key: 'columns',
        label: 'Columns',
        type: 'list',
        itemLabel: 'Column',
        description: 'Column headers, left to right.',
      },
      {
        key: 'rows',
        label: 'Rows',
        type: 'list',
        itemLabel: 'Row',
        description: 'One array of cell values per row, aligned to the columns.',
      },
    ],
  },
  {
    id: 'generic',
    label: 'Other',
    description:
      'Anything that does not clearly match another type. Use this rather than forcing a poor fit.',
    fields: [
      { key: 'title', label: 'Title', type: 'string' },
      { key: 'summary', label: 'Summary', type: 'text' },
      entriesField,
    ],
  },
];

export const FALLBACK_TEMPLATE_ID = 'generic';

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/** Look up a template, falling back to `generic` for anything unrecognised. */
export function getTemplate(id) {
  return BY_ID.get(id) || BY_ID.get(FALLBACK_TEMPLATE_ID);
}

export function isKnownTemplate(id) {
  return BY_ID.has(id);
}
