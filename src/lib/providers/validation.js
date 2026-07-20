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

/** True when an endpoint looks like a base URL rather than an API path. */
export function needsCompletionsPath(endpoint) {
  try {
    return !/completions|responses|generate/i.test(new URL(endpoint).pathname);
  } catch {
    return false;
  }
}

/** Suggest the conventional chat completions path for a base URL. */
export function suggestCompletionsUrl(endpoint) {
  try {
    const url = new URL(endpoint);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    return url.toString();
  } catch {
    return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
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
      // A base URL here returns the provider's web page instead of an API
      // response, which is confusing to diagnose after the fact.
      if (!errors.endpoint && needsCompletionsPath(endpoint)) {
        notes.push(
          `This looks like a base URL, not a chat completions endpoint. Try ${suggestCompletionsUrl(
            endpoint
          )}`
        );
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
