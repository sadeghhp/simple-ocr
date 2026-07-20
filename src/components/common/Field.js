'use client';

import { useId } from 'react';

const inputClasses =
  'w-full rounded-md border border-edge-strong bg-panel px-3 text-sm text-ink placeholder:text-ink-faint focus:outline-2 focus:outline-offset-1 focus:outline-accent disabled:bg-panel-muted disabled:text-ink-faint';

/**
 * Labeled input with optional hint / error / warning line. The description
 * carries `descriptionId` so the control's aria-describedby resolves to a real
 * element — otherwise hints and validation errors are invisible to screen
 * readers.
 */
export function Field({ label, hint, error, warning, children, htmlFor, descriptionId }) {
  const description = error || warning || hint;
  const tone = error ? 'text-danger' : warning ? 'text-warning' : 'text-ink-faint';
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {description ? (
        <p
          id={descriptionId}
          role={error ? 'alert' : undefined}
          className={`text-[13px] ${tone}`}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ label, hint, error, warning, className = '', ...props }) {
  const id = useId();
  const descriptionId = `${id}-desc`;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      warning={warning}
      htmlFor={id}
      descriptionId={descriptionId}
    >
      <input
        id={id}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error || warning || hint ? descriptionId : undefined}
        className={`${inputClasses} h-9 ${className}`}
        {...props}
      />
    </Field>
  );
}

export function TextArea({ label, hint, error, warning, className = '', rows = 3, ...props }) {
  const id = useId();
  const descriptionId = `${id}-desc`;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      warning={warning}
      htmlFor={id}
      descriptionId={descriptionId}
    >
      <textarea
        id={id}
        rows={rows}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error || warning || hint ? descriptionId : undefined}
        className={`${inputClasses} resize-y py-2 ${className}`}
        {...props}
      />
    </Field>
  );
}
