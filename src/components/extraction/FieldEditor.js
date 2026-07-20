'use client';

/**
 * Renders an extraction against its template.
 *
 * This is the third consumer of the template catalog (prompt and coercion are
 * the others); `tests/extraction-templates.test.js` asserts all three handle
 * every declared field type, so a new type cannot land here unhandled.
 *
 * Everything is plain text input. Provider output is never rendered as markup.
 */
import { getTemplate } from '@/lib/extraction/templates';

const inputClasses =
  'w-full rounded-md border border-edge-strong bg-panel px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:outline-2 focus:outline-offset-1 focus:outline-accent';

function FieldLabel({ children, required }) {
  return (
    <span className="block text-[12px] font-medium text-ink-muted">
      {children}
      {required ? <span className="ml-1 text-ink-faint">(required)</span> : null}
    </span>
  );
}

/** A table field: one row object per entry, columns from `itemFields`. */
function TableField({ field, rows, onChange }) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return <p className="text-[13px] text-ink-faint">No {field.label.toLowerCase()} found.</p>;
  }
  return (
    // Wide tables scroll inside their own container so the panel never does.
    <div className="overflow-x-auto rounded-md border border-edge">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-panel-muted">
            {field.itemFields.map((column) => (
              <th key={column.key} scope="col" className="px-2 py-1.5 text-left font-medium text-ink-muted">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((row, rowIndex) => (
            // eslint-disable-next-line react/no-array-index-key -- rows have no
            // stable identity of their own; they are positional by nature.
            <tr key={rowIndex} className="border-t border-edge">
              {field.itemFields.map((column) => (
                <td key={column.key} className="px-1 py-1">
                  <input
                    className={`${inputClasses} border-transparent bg-transparent`}
                    aria-label={`${field.label} row ${rowIndex + 1} ${column.label}`}
                    value={row?.[column.key] ?? ''}
                    onChange={(event) => {
                      const next = list.map((entry, i) =>
                        i === rowIndex ? { ...entry, [column.key]: event.target.value } : entry
                      );
                      onChange(next);
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListField({ field, values, onChange }) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) {
    return <p className="text-[13px] text-ink-faint">No {field.label.toLowerCase()} found.</p>;
  }
  return (
    <ul className="space-y-1">
      {list.map((entry, index) => (
        // eslint-disable-next-line react/no-array-index-key -- positional data
        <li key={index}>
          <input
            className={inputClasses}
            aria-label={`${field.itemLabel || field.label} ${index + 1}`}
            value={Array.isArray(entry) ? entry.join(' | ') : (entry ?? '')}
            onChange={(event) => {
              const raw = event.target.value;
              const next = list.map((value, i) =>
                i === index ? (Array.isArray(entry) ? raw.split('|').map((s) => s.trim()) : raw) : value
              );
              onChange(next);
            }}
          />
        </li>
      ))}
    </ul>
  );
}

function Field({ field, value, onChange }) {
  const common = {
    id: `field-${field.key}`,
    className: inputClasses,
    value: value ?? '',
    onChange: (event) => onChange(event.target.value),
  };

  switch (field.type) {
    case 'table':
      return <TableField field={field} rows={value} onChange={onChange} />;
    case 'list':
      return <ListField field={field} values={value} onChange={onChange} />;
    case 'text':
      return <textarea {...common} rows={4} className={`${inputClasses} resize-y`} />;
    case 'boolean':
      return (
        <select
          {...common}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : event.target.value === 'true')
          }
        >
          <option value="">Not found</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'enum':
      return (
        <select {...common} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">Not found</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      );
    case 'number':
    case 'money':
    case 'date':
    case 'string':
    default:
      // Values stay strings exactly as printed — reformatting an amount or a
      // date loses information the page actually carried.
      return <input {...common} placeholder={field.example || ''} />;
  }
}

/**
 * @param {object} props
 * @param {object} props.extraction stored extraction record
 * @param {(fields: object) => void} props.onChange called with the full field map
 * @param {boolean} [props.disabled]
 */
export function FieldEditor({ extraction, onChange, disabled = false }) {
  if (!extraction) return null;

  const template = getTemplate(extraction.documentType);
  const fields = extraction.fields ?? {};
  const extraFields = extraction.extraFields ?? [];

  const setField = (key, value) => {
    if (disabled) return;
    onChange({ ...fields, [key]: value });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-accent-edge bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
          {template.label}
        </span>
        {typeof extraction.confidence === 'number' ? (
          <span className="text-[12px] text-ink-faint">
            {Math.round(extraction.confidence * 100)}% confident
          </span>
        ) : null}
        {extraction.language ? (
          <span className="text-[12px] text-ink-faint">{extraction.language}</span>
        ) : null}
      </div>

      <fieldset disabled={disabled} className="space-y-3">
        {template.fields.map((field) => (
          <div key={field.key} className="space-y-1">
            <label htmlFor={`field-${field.key}`}>
              <FieldLabel required={field.required}>{field.label}</FieldLabel>
            </label>
            <Field field={field} value={fields[field.key]} onChange={(v) => setField(field.key, v)} />
          </div>
        ))}
      </fieldset>

      {extraFields.length > 0 ? (
        <div className="space-y-2 rounded-md border border-edge bg-panel-muted p-3">
          <h4 className="text-[12px] font-medium text-ink-muted">
            Other fields found on this page
          </h4>
          <dl className="space-y-1">
            {extraFields.map((entry) => (
              <div key={entry.key} className="flex gap-2 text-[12px]">
                <dt className="shrink-0 font-medium text-ink-muted">{entry.key}</dt>
                <dd className="min-w-0 break-words text-ink">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {extraction.notes ? (
        <p className="text-[12px] text-ink-faint">
          <span className="font-medium">Model notes:</span> {extraction.notes}
        </p>
      ) : null}
    </div>
  );
}
