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
import {
  DEFAULT_OCR_INSTRUCTION,
  assertProviderConfigured,
  buildCompletionsUrl,
} from '@/lib/providers/validation';
import { buildSystemMessages } from '@/lib/extraction/prompt';
import { parseExtractionPayload } from '@/lib/extraction/parse';
import { coerceExtraction, degradedExtraction } from '@/lib/extraction/coerce';

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

/**
 * The user's OCR instruction, but only when they have actually customized it.
 * The stock instruction is fully subsumed by the extraction contract, and
 * sending both just repeats the ask in weaker words.
 */
function customInstruction(config) {
  const instruction = (config.instruction || '').trim();
  if (!instruction || instruction === DEFAULT_OCR_INSTRUCTION.trim()) return null;
  return instruction;
}

/**
 * Translate Chat-Completions-shaped content parts (`text`/`image_url`/`file`)
 * into their Responses API equivalents (`input_text`/`input_image`/
 * `input_file`). The two APIs describe the same content, just with different
 * type names and a flattened `image_url` (a string, not `{ url }`).
 */
function toResponsesContentParts(parts) {
  return (parts || []).map((part) => {
    if (part.type === 'image_url') {
      return { type: 'input_image', image_url: part.image_url?.url };
    }
    if (part.type === 'file') {
      return { type: 'input_file', filename: part.file?.filename, file_data: part.file?.file_data };
    }
    return { type: 'input_text', text: part.text };
  });
}

/**
 * True when the resolved request URL is a Responses API endpoint
 * (`.../responses`) rather than Chat Completions (`.../chat/completions`).
 * Detected from the URL because that is the only signal available before a
 * request is ever made — the provider config has no separate "API style" field.
 */
export function isResponsesApiUrl(requestUrl) {
  try {
    return /\/responses(?:\/|\?|$)/i.test(new URL(requestUrl).pathname);
  } catch {
    return false;
  }
}

export function buildRequest(config, contentParts, { jsonMode = true, apiStyle = 'chat' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  for (const header of config.headers || []) {
    const headerName = (header.name || '').trim();
    if (headerName) headers[headerName] = header.value ?? '';
  }
  const systemMessages = buildSystemMessages(customInstruction(config));
  const jsonModeEnabled = jsonMode && config.supportsJsonMode !== false;

  if (apiStyle === 'responses') {
    const body = {
      model: config.model,
      input: [...systemMessages, { role: 'user', content: toResponsesContentParts(contentParts) }],
    };
    // Same "send it, withdraw it on rejection" strategy as response_format below.
    if (jsonModeEnabled) body.text = { format: { type: 'json_object' } };
    return { headers, body };
  }

  const body = {
    model: config.model,
    messages: [...systemMessages, { role: 'user', content: contentParts }],
  };
  // Many OpenAI-compatible gateways reject response_format outright, so this is
  // sent optimistically and withdrawn on the one-shot downgrade in runOcr.
  if (jsonModeEnabled) {
    body.response_format = { type: 'json_object' };
  }
  return { headers, body };
}

/** Provider complaints that mean "I do not understand response_format". */
const JSON_MODE_REJECTION = /response_format|json_object|json mode|json_schema|not supported|unrecognized|unknown (field|parameter|argument)|invalid.*parameter/i;

function looksLikeJsonModeRejection(error) {
  if (!error) return false;
  // A 400/422 is the shape of "I do not understand this field"; a 500 is the
  // provider failing for its own reasons and retrying without JSON mode would
  // just lose the structure for nothing.
  const text = `${error.message || ''} ${error.detail || ''}`;
  return JSON_MODE_REJECTION.test(text);
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
  if (
    /does not support|not support (image|vision|file|pdf)|modality|unsupported (image|file|input)|no vision|at most 0 image/.test(
      text
    )
  ) {
    return as(ERROR_CODES.MODEL_REJECTED_INPUT);
  }
  if (/content filter|safety|blocked|prohibited/.test(text)) {
    return as(ERROR_CODES.CONTENT_FILTERED);
  }
  return as(ERROR_CODES.PROVIDER_ERROR, { retryable: status == null || status >= 500 });
}

/**
 * Extract text from an OpenAI-compatible response.
 * Every failure path reports what was actually received.
 */
export function parseResponse(payload, { apiStyle = 'chat' } = {}) {
  const providerError = extractProviderError(payload);
  if (providerError) {
    throw classifyProviderError(providerError);
  }

  if (apiStyle === 'responses') return parseResponsesApiPayload(payload);
  return parseChatCompletionsPayload(payload);
}

/** Extract text from a Chat Completions payload (`choices[0].message.content`). */
function parseChatCompletionsPayload(payload) {
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

/**
 * Extract text from a Responses API payload. Prefers the `output_text`
 * convenience field; falls back to concatenating `output_text` parts off
 * `message` items in `output`, since not every provider populates the former.
 */
function parseResponsesApiPayload(payload) {
  const hasOutputArray = Array.isArray(payload?.output);
  const outputText = typeof payload?.output_text === 'string' ? payload.output_text : null;

  if (!hasOutputArray && outputText === null) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'Response contained no "output" array', {
      retryable: true,
      detail: `The reply had no "output" array. Top-level fields received: ${
        keys.length ? keys.join(', ') : '(none)'
      }.\nFull reply: ${truncate(payload)}`,
      hint: 'This usually means the endpoint is not an OpenAI-compatible Responses API URL, or the provider returned an unexpected error shape.',
    });
  }

  let text = outputText;
  if (text === null) {
    text = payload.output
      .filter((item) => item?.type === 'message')
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }

  if (typeof text === 'string' && text.trim() !== '') return text;

  // The model replied but produced no usable text — status/incomplete_details says why.
  const reason = payload?.incomplete_details?.reason ?? null;
  const baseDetail = `status: ${payload?.status ?? 'not reported'}, incomplete reason: ${
    reason ?? 'not reported'
  }. Output received: ${truncate(payload?.output ?? payload)}`;

  if (reason === 'max_output_tokens') {
    throw new AppError(ERROR_CODES.RESPONSE_TRUNCATED, 'Model hit its output limit', {
      retryable: true,
      detail: baseDetail,
      hint: 'The model stopped at its maximum output length before producing text. Try a model with a larger output limit, or a smaller document.',
    });
  }
  if (reason === 'content_filter') {
    throw new AppError(ERROR_CODES.CONTENT_FILTERED, 'Blocked by the model content filter', {
      detail: baseDetail,
      hint: 'The provider blocked this document. Try a different model or provider.',
    });
  }
  if (hasOutputArray && payload.output.some((item) => item?.type === 'reasoning')) {
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

/**
 * A provider that accepts the connection and never answers would otherwise
 * pin a page in `processing` forever — and at DEFAULT_CONCURRENCY = 1 that
 * blocks every remaining page of the document behind it.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/**
 * Combine the caller's cancel signal with a deadline.
 *
 * The two are tracked separately on purpose: a timeout must be reported as a
 * retryable network failure, never as a cancellation the user never asked for.
 * `timedOut()` is what tells the two aborts apart after the fact.
 */
function createDeadline(callerSignal, timeoutMs) {
  // Without AbortController there is no way to enforce a deadline; the request
  // still runs, it just cannot be cut short.
  if (typeof AbortController === 'undefined') {
    return { signal: callerSignal, timedOut: () => false, cleanup: () => {} };
  }
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener?.('abort', onCallerAbort);
    },
  };
}

/**
 * One request/response cycle. Returns `{ text, payload, apiStyle }` or throws
 * an AppError.
 */
async function attemptOcr(
  contentParts,
  config,
  { fetchImpl, signal, jsonMode, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }
) {
  // config.endpoint stores the base URL (e.g. http://localhost:1234/v1); the
  // request goes to its /chat/completions path — unless it already points at
  // a Responses API endpoint, which is left as-is and drives a different wire
  // format below.
  const requestUrl = buildCompletionsUrl(config.endpoint.trim());
  const apiStyle = isResponsesApiUrl(requestUrl) ? 'responses' : 'chat';
  const { headers, body } = buildRequest(config, contentParts, { jsonMode, apiStyle });

  // The deadline covers reading the body too, not just the response headers:
  // a provider that streams one byte a minute is just as stuck.
  const deadline = createDeadline(signal, timeoutMs);
  const timedOutError = (err) =>
    new AppError(
      ERROR_CODES.NETWORK_ERROR,
      `The provider did not respond within ${Math.round(timeoutMs / 1000)}s`,
      {
        retryable: true,
        cause: err,
        detail: `No response from ${requestUrl} within ${timeoutMs}ms.`,
        hint: 'The provider accepted the request but never answered. Check that the model is loaded and the endpoint is responding.',
      }
    );

  try {
    return await runRequest();
  } finally {
    deadline.cleanup();
  }

  async function runRequest() {
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
    } catch (err) {
      // The deadline elapsed. This is a provider/network problem, and it is
      // worth retrying — reporting it as a cancellation would be a lie.
      if (deadline.timedOut() && !signal?.aborted) throw timedOutError(err);
      // A cancelled request must not be reported as a network failure — telling
      // someone to check their connection after they pressed Cancel is nonsense.
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new AppError(ERROR_CODES.PROCESSING_CANCELLED, 'Request was cancelled', {
          cause: err,
          retryable: true,
        });
      }
      // fetch rejects with TypeError for both network failures and CORS
      // blocks; the browser hides which one it was.
      throw new AppError(ERROR_CODES.NETWORK_ERROR, err?.message || 'Request failed', {
        retryable: true,
        cause: err,
        detail: `The browser could not complete the request to ${requestUrl}.\nReported by the browser: ${
          err?.message || 'no detail'
        }`,
        hint: 'The browser cannot tell a network failure apart from a CORS rejection. Confirm the base URL is reachable and the provider allows browser (CORS) requests.',
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
      // Only add the base-URL hint where the URL is a plausible cause; codes
      // like AUTHENTICATION_FAILED have better advice of their own.
      if (!error.hint && ENDPOINT_HINT_CODES.has(error.code)) {
        error.hint = `Requested ${requestUrl}. Confirm the base URL in provider settings is correct.`;
      }
      throw error;
    }

    // Reading the body can abort too — the deadline is still armed here, and a
    // stalled stream aborts mid-read. Without this the raw DOMException would
    // escape unclassified, and every caller expects an AppError.
    let bodyText;
    try {
      bodyText = await response.text();
    } catch (err) {
      if (deadline.timedOut() && !signal?.aborted) throw timedOutError(err);
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new AppError(ERROR_CODES.PROCESSING_CANCELLED, 'Request was cancelled', {
          cause: err,
          retryable: true,
        });
      }
      throw new AppError(ERROR_CODES.NETWORK_ERROR, 'The provider response was cut short', {
        retryable: true,
        cause: err,
        detail: `HTTP ${response.status} from ${requestUrl}, but the body could not be read.\nReported by the browser: ${
          err?.message || 'no detail'
        }`,
      });
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (err) {
      throw new AppError(ERROR_CODES.NOT_JSON_RESPONSE, 'Provider response was not JSON', {
        retryable: true,
        cause: err,
        detail: `HTTP ${response.status} from ${requestUrl}, but the body is not JSON.\nBody received: ${truncate(
          bodyText,
          300
        )}`,
        hint: 'A non-JSON reply usually means the base URL points at a web page or proxy rather than the API.',
      });
    }

    let text;
    try {
      text = parseResponse(payload, { apiStyle });
    } catch (err) {
      // Attach the model actually used so mismatches are obvious.
      if (err instanceof AppError && err.detail) {
        err.detail = `Requested model: ${config.model}\n${err.detail}`;
      }
      throw err;
    }
    return { text, payload, apiStyle };
  }
}

/**
 * Run OCR for one stored file or rendered page.
 *
 * Returns `{ text, extraction, warnings, provider, model, processedAt,
 * rawMetadata, jsonModeRejected }`. `text` is the page's plain text and keeps
 * its original meaning; `extraction` is the structured document.
 *
 * A reply that is not valid JSON does NOT fail: the whole reply is preserved as
 * a degraded extraction with a warning. Losing a good page of OCR because the
 * model wrapped it badly would be the worst outcome available.
 */
export async function runOcr(
  blob,
  fileMeta,
  config,
  { fetchImpl = fetch, signal = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}
) {
  assertProviderConfigured(config);
  const contentParts = await buildContentParts(blob, fileMeta.mimeType, fileMeta.name);

  let jsonMode = config.supportsJsonMode !== false;
  let jsonModeRejected = false;
  let result;

  try {
    result = await attemptOcr(contentParts, config, { fetchImpl, signal, jsonMode, timeoutMs });
  } catch (err) {
    if (!jsonMode || !looksLikeJsonModeRejection(err)) throw err;
    // The gateway does not understand response_format. Retry once without it
    // and let the caller remember, so this costs one request per provider and
    // not one per page.
    jsonMode = false;
    jsonModeRejected = true;
    result = await attemptOcr(contentParts, config, {
      fetchImpl,
      signal,
      jsonMode: false,
      timeoutMs,
    });
  }

  const { text, payload, apiStyle } = result;
  const parsed = parseExtractionPayload(text);

  let extraction;
  let warnings;
  if (parsed.data) {
    const coerced = coerceExtraction(parsed.data, { fallbackText: text });
    extraction = coerced.extraction;
    warnings = [...parsed.warnings, ...coerced.warnings];
  } else {
    extraction = degradedExtraction(text);
    warnings = [...parsed.warnings, ERROR_CODES.EXTRACTION_NOT_JSON];
  }

  return {
    // Plain text stays the primary result: the editor, export and search all
    // read this, and they must keep working regardless of the JSON.
    text: extraction.rawText || text,
    extraction,
    warnings,
    jsonModeRejected,
    provider: config.name || new URL(config.endpoint).hostname,
    model: payload?.model || config.model,
    processedAt: new Date().toISOString(),
    rawMetadata: {
      responseModel: payload?.model ?? null,
      usage: payload?.usage ?? null,
      finishReason:
        apiStyle === 'responses'
          ? (payload?.incomplete_details?.reason ?? payload?.status ?? null)
          : (payload?.choices?.[0]?.finish_reason ?? null),
    },
  };
}

/**
 * Send a minimal, text-only chat-completions request to confirm the base URL,
 * model, and credentials actually work, without touching any document.
 * Returns `{ ok: true, model, reply, elapsedMs }` or throws the same
 * classified AppError that runOcr would.
 */
export async function testProviderConnection(
  config,
  // A shorter deadline than a real page: someone is sitting in front of the
  // settings dialog waiting for this, and a one-word reply is not slow.
  { fetchImpl = fetch, signal = null, timeoutMs = 30000 } = {}
) {
  assertProviderConfigured(config);
  const contentParts = [
    { type: 'text', text: 'Reply with only the single word: ok' },
  ];
  const startedAt = Date.now();
  const result = await attemptOcr(contentParts, config, {
    fetchImpl,
    signal,
    jsonMode: false,
    timeoutMs,
  });

  return {
    ok: true,
    model: result.payload?.model || config.model,
    reply: result.text.trim(),
    elapsedMs: Date.now() - startedAt,
  };
}
