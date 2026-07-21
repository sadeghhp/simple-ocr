/**
 * Provider configuration validation (spec §15.3, §19).
 */
import { AppError, ERROR_CODES } from '@/lib/errors';

export const DEFAULT_OCR_INSTRUCTION =
  'Extract all text from this document exactly as it appears. Preserve the reading order and line breaks. Return only the extracted text with no commentary.';

export function emptyProviderConfig() {
  return {
    name: '',
    endpoint: '',
    model: '',
    apiKey: '',
    headers: [],
    instruction: DEFAULT_OCR_INSTRUCTION,
  };
}

/** True when a URL's path already looks like a specific completions/generate endpoint. */
function looksLikeCompletionsPath(pathname) {
  return /completions|responses|generate/i.test(pathname);
}

/**
 * Build the actual request URL from the configured base URL (spec: standard
 * "base URL" form, e.g. `http://localhost:1234/v1`, matching how other
 * OpenAI-compatible tools take provider config). `/chat/completions` is
 * appended automatically. Configs saved before this change may already store
 * a full completions URL, so an existing completions-shaped path is left
 * untouched rather than doubled up.
 */
export function buildCompletionsUrl(endpoint) {
  const trimmed = (endpoint || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (looksLikeCompletionsPath(url.pathname)) return trimmed;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    return url.toString();
  } catch {
    return `${trimmed}/chat/completions`;
  }
}

/**
 * Validate field-by-field for the settings form.
 * Returns `{ errors: {field: message}, warnings: {field: message} }`.
 */
export function validateProviderConfig(config) {
  const errors = {};
  const warnings = {};
  if (!config || typeof config !== 'object') {
    return { errors: { endpoint: 'Provider configuration is missing.' }, warnings };
  }

  const endpoint = (config.endpoint || '').trim();
  if (!endpoint) {
    errors.endpoint = 'Endpoint is required.';
  } else {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      errors.endpoint = 'Endpoint must be a valid URL.';
    }
    if (url) {
      const notes = [];
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.endpoint = 'Endpoint must use http or https.';
      } else if (
        url.protocol === 'http:' &&
        url.hostname !== 'localhost' &&
        url.hostname !== '127.0.0.1'
      ) {
        notes.push('This endpoint is not HTTPS. The API key will travel unencrypted.');
      }
      if (notes.length > 0) warnings.endpoint = notes.join(' ');
    }
  }

  if (!(config.model || '').trim()) {
    errors.model = 'Model name is required.';
  }

  for (const header of config.headers || []) {
    if ((header.name || '').trim() === '' && (header.value || '').trim() !== '') {
      errors.headers = 'Each extra header needs a name.';
    }
  }

  return { errors, warnings };
}

/** True when the config is complete enough to attempt a request. */
export function isProviderConfigured(config) {
  if (!config) return false;
  return Object.keys(validateProviderConfig(config).errors).length === 0;
}

/** Throw a normalized error when processing is attempted without a valid config. */
export function assertProviderConfigured(config) {
  if (!config) {
    throw new AppError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'No provider configured');
  }
  const { errors } = validateProviderConfig(config);
  if (errors.endpoint) {
    throw new AppError(ERROR_CODES.INVALID_ENDPOINT, errors.endpoint);
  }
  if (Object.keys(errors).length > 0) {
    throw new AppError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, Object.values(errors).join(' '));
  }
}
