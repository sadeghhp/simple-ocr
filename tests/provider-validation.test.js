import { describe, expect, it } from 'vitest';
import {
  buildCompletionsUrl,
  emptyProviderConfig,
  isProviderConfigured,
  validateProviderConfig,
} from '@/lib/providers/validation';

const valid = () => ({
  ...emptyProviderConfig(),
  endpoint: 'http://localhost:1234/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
});

describe('validateProviderConfig', () => {
  it('accepts a complete https configuration', () => {
    const { errors, warnings } = validateProviderConfig(valid());
    expect(errors).toEqual({});
    expect(warnings).toEqual({});
  });

  it('requires endpoint and model', () => {
    const { errors } = validateProviderConfig(emptyProviderConfig());
    expect(errors.endpoint).toBeTruthy();
    expect(errors.model).toBeTruthy();
  });

  it('rejects malformed and non-http URLs', () => {
    expect(validateProviderConfig({ ...valid(), endpoint: 'not a url' }).errors.endpoint).toBeTruthy();
    expect(
      validateProviderConfig({ ...valid(), endpoint: 'file:///etc/passwd' }).errors.endpoint
    ).toBeTruthy();
    expect(validateProviderConfig({ ...valid(), endpoint: 'ftp://x.com' }).errors.endpoint).toBeTruthy();
  });

  it('warns on plain http for non-local hosts but allows localhost', () => {
    expect(
      validateProviderConfig({ ...valid(), endpoint: 'http://api.example.com/v1/chat/completions' })
        .warnings.endpoint
    ).toMatch(/not HTTPS/);
    const local = validateProviderConfig({
      ...valid(),
      endpoint: 'http://localhost:11434/v1/chat/completions',
    });
    expect(local.errors).toEqual({});
    expect(local.warnings).toEqual({});
  });

  it('accepts a plain base URL with no path, the standard custom-LLM form', () => {
    const { errors, warnings } = validateProviderConfig({
      ...valid(),
      endpoint: 'https://openrouter.ai/api/v1',
    });
    expect(errors).toEqual({});
    expect(warnings).toEqual({});
  });

  it('buildCompletionsUrl appends /chat/completions to a base URL without duplicating slashes', () => {
    expect(buildCompletionsUrl('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    );
    expect(buildCompletionsUrl('https://openrouter.ai/api/v1/')).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    );
    expect(buildCompletionsUrl('http://localhost:1234/v1')).toBe(
      'http://localhost:1234/v1/chat/completions'
    );
  });

  it('buildCompletionsUrl leaves an already-complete completions URL untouched', () => {
    for (const endpoint of [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.openai.com/v1/responses',
      'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
    ]) {
      expect(buildCompletionsUrl(endpoint)).toBe(endpoint);
    }
  });

  it('flags extra headers with a value but no name', () => {
    const { errors } = validateProviderConfig({
      ...valid(),
      headers: [{ name: '', value: 'x' }],
    });
    expect(errors.headers).toBeTruthy();
  });

  it('isProviderConfigured reflects completeness', () => {
    expect(isProviderConfigured(null)).toBe(false);
    expect(isProviderConfigured(emptyProviderConfig())).toBe(false);
    expect(isProviderConfigured(valid())).toBe(true);
  });
});
