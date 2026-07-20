'use client';

import { useEffect, useState } from 'react';
import { Button, IconButton } from '@/components/common/Button';
import { Dialog } from '@/components/common/Dialog';
import { TextArea, TextInput } from '@/components/common/Field';
import { CloseIcon } from '@/components/common/icons';
import {
  emptyProviderConfig,
  needsCompletionsPath,
  suggestCompletionsUrl,
  validateProviderConfig,
} from '@/lib/providers/validation';

/**
 * Provider settings (spec §25.2). One active custom configuration; states
 * plainly that the API key is stored locally and is not a secret (§15.1).
 */
export function ProviderSettingsDialog({ open, onClose, config, onSave, onDeleteAllData }) {
  const [draft, setDraft] = useState(emptyProviderConfig());
  const [validation, setValidation] = useState({ errors: {}, warnings: {} });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    if (open) {
      const next = { ...emptyProviderConfig(), ...(config || {}) };
      setDraft(next);
      // Warnings render immediately; errors wait until a save is attempted.
      setValidation(config ? validateProviderConfig(next) : { errors: {}, warnings: {} });
      setAttempted(false);
      setSaveError(null);
    }
  }, [open, config]);

  const set = (field) => (event) => {
    const next = { ...draft, [field]: event.target.value };
    setDraft(next);
    setValidation(validateProviderConfig(next));
  };

  const setHeader = (index, field, value) => {
    const headers = draft.headers.map((h, i) => (i === index ? { ...h, [field]: value } : h));
    setDraft({ ...draft, headers });
  };

  const submit = async () => {
    const result = validateProviderConfig(draft);
    setValidation(result);
    setAttempted(true);
    if (Object.keys(result.errors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        ...draft,
        name: draft.name.trim(),
        endpoint: draft.endpoint.trim(),
        model: draft.model.trim(),
        headers: draft.headers.filter((h) => (h.name || '').trim() !== ''),
      });
      onClose();
    } catch (err) {
      setSaveError(err?.message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const { errors, warnings } = validation;
  const suggestedEndpoint = needsCompletionsPath(draft.endpoint)
    ? suggestCompletionsUrl(draft.endpoint)
    : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Provider settings"
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
          Settings are stored only in this browser and sent only to the endpoint below. A
          browser app cannot keep an API key truly secret — anyone with access to this browser
          profile or its developer tools can read it. Use a restricted, low-risk key and set
          usage limits on the provider side.
        </p>

        <TextInput
          label="Provider name"
          placeholder="e.g. OpenRouter"
          value={draft.name}
          onChange={set('name')}
          hint="A label for your own reference."
        />
        <div className="space-y-1.5">
          <TextInput
            label="API endpoint"
            placeholder="https://api.example.com/v1/chat/completions"
            value={draft.endpoint}
            onChange={set('endpoint')}
            error={attempted ? errors.endpoint : undefined}
            warning={warnings.endpoint}
            hint="The full chat completions URL, e.g. https://openrouter.ai/api/v1/chat/completions. The endpoint must allow browser (CORS) requests."
            autoComplete="off"
            spellCheck={false}
          />
          {suggestedEndpoint ? (
            <Button
              size="sm"
              onClick={() => {
                const next = { ...draft, endpoint: suggestedEndpoint };
                setDraft(next);
                setValidation(validateProviderConfig(next));
              }}
            >
              Use {suggestedEndpoint}
            </Button>
          ) : null}
        </div>
        <TextInput
          label="Model"
          placeholder="e.g. gpt-4o-mini"
          value={draft.model}
          onChange={set('model')}
          error={attempted ? errors.model : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <TextInput
          label="API key"
          type="password"
          placeholder="Optional for local providers"
          value={draft.apiKey}
          onChange={set('apiKey')}
          hint="Sent as an Authorization: Bearer header. Never included in exports."
          autoComplete="off"
        />

        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium text-ink">
            Extra request headers <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          {draft.headers.map((header, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                aria-label={`Header ${index + 1} name`}
                placeholder="Header name"
                value={header.name}
                onChange={(e) => setHeader(index, 'name', e.target.value)}
                className="h-9 w-2/5 rounded-md border border-edge-strong bg-panel px-3 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-accent"
                spellCheck={false}
              />
              <input
                aria-label={`Header ${index + 1} value`}
                placeholder="Value"
                value={header.value}
                onChange={(e) => setHeader(index, 'value', e.target.value)}
                className="h-9 flex-1 rounded-md border border-edge-strong bg-panel px-3 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-accent"
                spellCheck={false}
              />
              <IconButton
                label={`Remove header ${index + 1}`}
                onClick={() =>
                  setDraft({ ...draft, headers: draft.headers.filter((_, i) => i !== index) })
                }
              >
                <CloseIcon size={14} />
              </IconButton>
            </div>
          ))}
          {attempted && errors.headers ? (
            <p className="text-[13px] text-danger">{errors.headers}</p>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setDraft({ ...draft, headers: [...draft.headers, { name: '', value: '' }] })
            }
          >
            + Add header
          </Button>
        </div>

        <TextArea
          label="OCR instruction"
          rows={3}
          value={draft.instruction}
          onChange={set('instruction')}
          hint="Sent as the system prompt with every OCR request."
        />

        {saveError ? <p className="text-[13px] text-danger">{saveError}</p> : null}

        {onDeleteAllData ? (
          <div className="border-t border-edge pt-4">
            <h3 className="text-[13px] font-medium text-ink">Danger zone</h3>
            <p className="mt-1 text-[13px] text-ink-faint">
              Remove every document, file, and setting stored by this app in this browser.
            </p>
            <Button size="sm" variant="danger" className="mt-2" onClick={onDeleteAllData}>
              Delete all local data…
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
