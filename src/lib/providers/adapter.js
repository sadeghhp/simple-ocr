/**
 * Provider adapter (spec §4.4, §6.4).
 *
 * Converts the app's internal OCR request into an OpenAI-compatible
 * chat-completions request, sends it, and normalizes the result. This is the
 * only module that understands the provider's wire format; the rest of the
 * app sees `{ text, provider, model, processedAt, rawMetadata }` or AppError.
 */
import { AppError, ERROR_CODES, toAppError } from '@/lib/errors';
import { blobToBase64, blobToDataUrl, blobToText } from '@/lib/files/convert';
import { DEFAULT_OCR_INSTRUCTION, assertProviderConfigured } from '@/lib/providers/validation';

/** Build the user-message content parts for the given file. */
async function buildContentParts(blob, mimeType, name) {
  if (mimeType.startsWith('image/')) {
    // Use the detected type, not blob.type — a file picked up without a
    // registered type would otherwise be sent as application/octet-stream.
    const dataUrl = await blobToDataUrl(blob, mimeType);
    return [
      { type: 'text', text: 'Extract the text from this image.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
  }
  if (mimeType === 'application/pdf') {
    const base64 = await blobToBase64(blob);
    return [
      { type: 'text', text: 'Extract the text from this PDF document.' },
      { type: 'file', file: { filename: name || 'document.pdf', file_data: `data:application/pdf;base64,${base64}` } },
    ];
  }
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    const text = await blobToText(blob);
    return [
      {
        type: 'text',
        text: `Clean up and return the text of this document:\n\n${text}`,
      },
    ];
  }
  throw new AppError(
    ERROR_CODES.UNSUPPORTED_FILE,
    `This file type cannot be sent to the provider: ${mimeType}`
  );
}

export function buildRequest(config, contentParts) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  for (const header of config.headers || []) {
    const headerName = (header.name || '').trim();
    if (headerName) headers[headerName] = header.value ?? '';
  }
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: config.instruction || DEFAULT_OCR_INSTRUCTION },
      { role: 'user', content: contentParts },
    ],
  };
  return { headers, body };
}

const DETAIL_LIMIT = 700;

function truncate(text, limit = DETAIL_LIMIT) {
  const value = typeof text === 'string' ? text : JSON.stringify(text);
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}… (truncated)` : value;
}

/**
 * Pull a message out of an OpenAI/OpenRouter-style error envelope.
 * OpenRouter frequently returns these with HTTP 200, so the envelope must be
 * checked independently of the status code.
 */
export function extractProviderError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload.error;
  if (typeof envelope === 'string') return { message: envelope, code: null, raw: envelope };
  if (envelope && typeof envelope === 'object') {
    const nested = envelope.metadata?.raw ?? envelope.metadata ?? null;
    return {
      message: envelope.message || envelope.msg || JSON.stringify(envelope),
      code: envelope.code ?? envelope.type ?? null,
      raw: nested ? `${envelope.message ?? ''} ${truncate(nested, 300)}`.trim() : envelope.message,
    };
  }
  // Some gateways return a bare {message, code} with no choices.
  if (typeof payload.message === 'string' && !payload.choices) {
    return { message: payload.message, code: payload.code ?? null, raw: payload.message };
  }
  return null;
}

/**
 * Map a provider error (status + message) onto a specific application code so
 * the UI can give targeted advice instead of "something went wrong".
 */
export function classifyProviderError({ status = null, message = '', code = null } = {}) {
  const text = `${message} ${code ?? ''}`.toLowerCase();
  const detail = message
    ? `${status ? `HTTP ${status}: ` : ''}${message}`
    : status
      ? `HTTP ${status}`
      : 'No message supplied by the provider.';

  const as = (errorCode, options = {}) =>
    new AppError(errorCode, detail, { detail: truncate(detail), ...options });

  // Status codes are unambiguous, so they win over free-text matching: a 401
  // whose body happens to say "is not a valid user" is an auth failure, not a
  // bad model name.
  if (status === 401 || status === 403) return as(ERROR_CODES.AUTHENTICATION_FAILED);
  if (status === 402) return as(ERROR_CODES.INSUFFICIENT_CREDITS);
  if (status === 429) return as(ERROR_CODES.RATE_LIMITED, { retryable: true });

  // "No endpoints found" means the gateway knows the model but cannot route to
  // it — usually a data-policy setting rather than a wrong model name.
  if (/no endpoints found|no allowed providers|no providers available/.test(text)) {
    return as(ERROR_CODES.NO_PROVIDER_AVAILABLE);
  }
  if (/not a valid model|unknown model|model not found|is not a valid model|no such model/.test(text)) {
    return as(ERROR_CODES.MODEL_NOT_FOUND);
  }
  if (/insufficient|not enough credit|billing|payment required|quota exceeded/.test(text)) {
    return as(ERROR_CODES.INSUFFICIENT_CREDITS);
  }
  if (/api key|unauthorized|authentication|invalid token|no auth/.test(text)) {
    return as(ERROR_CODES.AUTHENTICATION_FAILED);
  }
  if (/rate limit|too many requests/.test(text)) {
    return as(ERROR_CODES.RATE_LIMITED, { retryable: true });
  }
  if (/does not support|not support (image|vision|file|pdf)|modality|unsupported (image|file|input)|no vision/.test(text)) {
    return as(ERROR_CODES.MODEL_REJECTED_INPUT);
  }
  if (/content filter|safety|blocked|prohibited/.test(text)) {
    return as(ERROR_CODES.CONTENT_FILTERED);
  }
  return as(ERROR_CODES.PROVIDER_ERROR, { retryable: status == null || status >= 500 });
}

/**
 * Extract text from an OpenAI-compatible chat-completions response.
 * Every failure path reports what was actually received.
 */
export function parseResponse(payload) {
  const providerError = extractProviderError(payload);
  if (providerError) {
    throw classifyProviderError(providerError);
  }

  const choice = payload?.choices?.[0];
  if (!choice) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    throw new AppError(
      ERROR_CODES.INVALID_RESPONSE,
      'Response contained no "choices" array',
      {
        retryable: true,
        detail: `The reply had no "choices" array. Top-level fields received: ${
          keys.length ? keys.join(', ') : '(none)'
        }.\nFull reply: ${truncate(payload)}`,
        hint: 'This usually means the endpoint is not an OpenAI-compatible chat completions URL, or the provider returned an unexpected error shape.',
      }
    );
  }

  const content = choice.message?.content ?? choice.text;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Some providers return content as an array of text parts.
    text = content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }

  if (typeof text === 'string' && text.trim() !== '') return text;

  // The model replied but produced no usable text — finish_reason says why.
  const finishReason = choice.finish_reason ?? choice.native_finish_reason ?? null;
  const baseDetail = `finish_reason: ${finishReason ?? 'not reported'}. Message object received: ${truncate(
    choice.message ?? choice
  )}`;

  if (finishReason === 'length') {
    throw new AppError(ERROR_CODES.RESPONSE_TRUNCATED, 'Model hit its output limit', {
      retryable: true,
      detail: baseDetail,
      hint: 'The model stopped at its maximum output length before producing text. Try a model with a larger output limit, or a smaller document.',
    });
  }
  if (finishReason === 'content_filter') {
    throw new AppError(ERROR_CODES.CONTENT_FILTERED, 'Blocked by the model content filter', {
      detail: baseDetail,
      hint: 'The provider blocked this document. Try a different model or provider.',
    });
  }
  if (choice.message?.reasoning) {
    throw new AppError(ERROR_CODES.EMPTY_COMPLETION, 'Model returned reasoning but no content', {
      retryable: true,
      detail: baseDetail,
      hint: 'This model returned internal reasoning with an empty content field. Choose a non-reasoning model for OCR, or disable reasoning on the provider side.',
    });
  }
  throw new AppError(ERROR_CODES.EMPTY_COMPLETION, 'Model returned empty content', {
    retryable: true,
    detail: baseDetail,
  });
}

/** Build an AppError from a non-2xx HTTP response, parsing JSON error bodies. */
function errorFromHttpStatus(status, bodyText) {
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    /* body was not JSON */
  }
  const envelope = extractProviderError(payload);
  if (envelope) {
    return classifyProviderError({ status, ...envelope });
  }
  return classifyProviderError({ status, message: truncate(bodyText, 300) });
}

/** Codes where a wrong endpoint URL is a plausible cause of the failure. */
const ENDPOINT_HINT_CODES = new Set([
  ERROR_CODES.PROVIDER_ERROR,
  ERROR_CODES.NOT_JSON_RESPONSE,
  ERROR_CODES.INVALID_RESPONSE,
]);

/** Flag an endpoint that is missing the chat completions path — a common slip. */
function endpointHint(endpoint) {
  try {
    const { pathname } = new URL(endpoint);
    if (!/completions|responses|generate/i.test(pathname)) {
      return `The endpoint path is "${pathname}". An OpenAI-compatible endpoint usually ends with /chat/completions.`;
    }
  } catch {
    /* validated elsewhere */
  }
  return null;
}

/**
 * Run OCR for one stored file.
 * @param {Blob} blob original file blob
 * @param {{mimeType: string, name: string}} fileMeta
 * @param {object} config provider configuration
 * @returns normalized `{ text, provider, model, processedAt, rawMetadata }`
 */
export async function runOcr(blob, fileMeta, config, { fetchImpl = fetch } = {}) {
  assertProviderConfigured(config);
  const endpoint = config.endpoint.trim();
  const contentParts = await buildContentParts(blob, fileMeta.mimeType, fileMeta.name);
  const { headers, body } = buildRequest(config, contentParts);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    // fetch rejects with TypeError for both network failures and CORS
    // blocks; the browser hides which one it was.
    throw new AppError(ERROR_CODES.NETWORK_ERROR, err?.message || 'Request failed', {
      retryable: true,
      cause: err,
      detail: `The browser could not complete the request to ${endpoint}.\nReported by the browser: ${
        err?.message || 'no detail'
      }`,
      hint:
        endpointHint(endpoint) ||
        'The browser cannot tell a network failure apart from a CORS rejection. Confirm the endpoint URL is reachable and allows browser requests.',
    });
  }

  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      /* body unavailable */
    }
    const error = errorFromHttpStatus(response.status, bodyText);
    // Only add the endpoint hint where the URL is a plausible cause; codes like
    // AUTHENTICATION_FAILED have better advice of their own.
    if (!error.hint && ENDPOINT_HINT_CODES.has(error.code)) {
      error.hint = endpointHint(endpoint);
    }
    throw error;
  }

  const bodyText = await response.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (err) {
    throw new AppError(ERROR_CODES.NOT_JSON_RESPONSE, 'Provider response was not JSON', {
      retryable: true,
      cause: err,
      detail: `HTTP ${response.status} from ${endpoint}, but the body is not JSON.\nBody received: ${truncate(
        bodyText,
        300
      )}`,
      hint:
        endpointHint(endpoint) ||
        'A non-JSON reply usually means the URL points at a web page or proxy rather than the API.',
    });
  }

  let text;
  try {
    text = parseResponse(payload);
  } catch (err) {
    // Attach the model actually used so mismatches are obvious.
    if (err instanceof AppError && err.detail) {
      err.detail = `Requested model: ${config.model}\n${err.detail}`;
    }
    throw err;
  }
  return {
    text,
    provider: config.name || new URL(config.endpoint).hostname,
    model: payload?.model || config.model,
    processedAt: new Date().toISOString(),
    rawMetadata: {
      responseModel: payload?.model ?? null,
      usage: payload?.usage ?? null,
      finishReason: payload?.choices?.[0]?.finish_reason ?? null,
    },
  };
}
