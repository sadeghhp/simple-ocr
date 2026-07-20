'use client';

import { useState } from 'react';
import { AlertIcon } from '@/components/common/icons';
import { errorDetail, errorHint, userMessage } from '@/lib/errors';

/**
 * Inline error banner (spec §14.4): plain-language headline, an actionable
 * hint, and a collapsed technical section for troubleshooting. Accepts an
 * AppError or a persisted processingError record. All provider text is
 * rendered as plain text.
 */
export function ErrorBanner({ error, action, className = '' }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!error) return null;
  const hint = errorHint(error);
  const detail = errorDetail(error);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable; the text is selectable anyway */
    }
  };

  return (
    <div
      role="alert"
      className={`rounded-md border border-danger-edge bg-danger-soft px-3 py-2.5 text-sm text-danger ${className}`}
    >
      <div className="flex items-start gap-2.5">
        <AlertIcon size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p>{userMessage(error)}</p>
          {hint ? <p className="mt-1.5 text-[13px] text-danger/85">{hint}</p> : null}

          {detail ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="rounded text-[12px] font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
              >
                {open ? 'Hide technical details' : 'Show technical details'}
              </button>
              {open ? (
                <div className="mt-1.5">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-danger-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-ink-muted">
                    {detail}
                  </pre>
                  <button
                    type="button"
                    onClick={copy}
                    className="mt-1.5 rounded text-[12px] font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
                  >
                    {copied ? 'Copied' : 'Copy details'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {action ? <div className="mt-2">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
