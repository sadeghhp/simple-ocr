import { describe, expect, it, vi } from 'vitest';
import {
  buildRequest,
  classifyProviderError,
  extractProviderError,
  parseResponse,
  runOcr,
  testProviderConnection,
} from '@/lib/providers/adapter';
import { emptyProviderConfig } from '@/lib/providers/validation';

const config = () => ({
  ...emptyProviderConfig(),
  name: 'Test Provider',
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'test-model',
  apiKey: 'sk-test',
  headers: [{ name: 'X-Custom', value: 'yes' }],
});

const pngBlob = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

const okResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('buildRequest', () => {
  it('includes auth, custom headers, model, and instruction', () => {
    const { headers, body } = buildRequest(config(), [{ type: 'text', text: 'hi' }]);
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['X-Custom']).toBe('yes');
    expect(body.model).toBe('test-model');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('omits Authorization without an API key', () => {
    const { headers } = buildRequest({ ...config(), apiKey: '' }, []);
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('parseResponse', () => {
  it('reads string content', () => {
    expect(parseResponse({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
  });

  it('joins array content parts', () => {
    expect(
      parseResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }] })
    ).toBe('ab');
  });

  it('reports the fields received when there is no choices array', () => {
    let thrown;
    try {
      parseResponse({ id: 'x', object: 'chat.completion' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('INVALID_RESPONSE');
    expect(thrown.detail).toContain('id, object');
  });

  it('classifies an empty completion and includes finish_reason', () => {
    let thrown;
    try {
      parseResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('EMPTY_COMPLETION');
    expect(thrown.detail).toContain('finish_reason: stop');
  });

  it('distinguishes truncation, content filtering, and reasoning-only replies', () => {
    expect(() =>
      parseResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })
    ).toThrowError(expect.objectContaining({ code: 'RESPONSE_TRUNCATED' }));

    expect(() =>
      parseResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })
    ).toThrowError(expect.objectContaining({ code: 'CONTENT_FILTERED' }));

    expect(() =>
      parseResponse({ choices: [{ message: { content: '', reasoning: 'thinking…' } }] })
    ).toThrowError(expect.objectContaining({ code: 'EMPTY_COMPLETION' }));
  });

  it('surfaces an error envelope returned with HTTP 200 (OpenRouter behaviour)', () => {
    let thrown;
    try {
      parseResponse({
        error: { code: 400, message: 'google/gemini-x-flash is not a valid model ID' },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('MODEL_NOT_FOUND');
    expect(thrown.detail).toContain('not a valid model ID');
  });

  it('falls back to the legacy completions text field', () => {
    expect(parseResponse({ choices: [{ text: 'legacy' }] })).toBe('legacy');
  });
});

describe('classifyProviderError', () => {
  it.each([
    ['No endpoints found matching your data policy', null, 'NO_PROVIDER_AVAILABLE'],
    ['google/gemini-x is not a valid model ID', null, 'MODEL_NOT_FOUND'],
    ['Insufficient credits to run this request', null, 'INSUFFICIENT_CREDITS'],
    ['No auth credentials found', null, 'AUTHENTICATION_FAILED'],
    ['Rate limit exceeded', null, 'RATE_LIMITED'],
    ['This model does not support image input', null, 'MODEL_REJECTED_INPUT'],
    ['Request blocked by safety filters', null, 'CONTENT_FILTERED'],
    ['Upstream exploded', 503, 'PROVIDER_ERROR'],
  ])('maps %s to %s', (message, status, expected) => {
    const error = classifyProviderError({ message, status });
    expect(error.code).toBe(expected);
    expect(error.detail).toContain(message);
  });

  it('classifies by status code when the message is unhelpful', () => {
    expect(classifyProviderError({ status: 402, message: '' }).code).toBe('INSUFFICIENT_CREDITS');
    expect(classifyProviderError({ status: 401, message: '' }).code).toBe('AUTHENTICATION_FAILED');
  });

  it('lets an unambiguous status win over loose message wording', () => {
    // A 401 body mentioning "is not a valid user" must not be reported as a
    // model problem — that would send the user to fix the wrong setting.
    expect(
      classifyProviderError({ status: 401, message: 'User not found or is not a valid user.' }).code
    ).toBe('AUTHENTICATION_FAILED');
    expect(
      classifyProviderError({ status: 429, message: 'model quota exceeded' }).code
    ).toBe('RATE_LIMITED');
  });
});

describe('extractProviderError', () => {
  it('reads object, string, and bare-message envelopes', () => {
    expect(extractProviderError({ error: { message: 'boom', code: 400 } }).message).toBe('boom');
    expect(extractProviderError({ error: 'plain failure' }).message).toBe('plain failure');
    expect(extractProviderError({ message: 'gateway down' }).message).toBe('gateway down');
    expect(extractProviderError({ choices: [] })).toBeNull();
  });
});

describe('runOcr', () => {
  it('normalizes a successful image OCR call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        model: 'test-model-2024',
        choices: [{ message: { content: 'Extracted!' }, finish_reason: 'stop' }],
        usage: { total_tokens: 42 },
      })
    );
    const result = await runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), {
      fetchImpl,
    });
    expect(result.text).toBe('Extracted!');
    expect(result.provider).toBe('Test Provider');
    expect(result.model).toBe('test-model-2024');
    expect(result.rawMetadata.usage.total_tokens).toBe(42);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('sends the detected image type even when the blob type is missing or generic', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 })
      );
    // A file dropped from a zip or an unusual file manager can arrive with no
    // type at all, while validation identified it by extension.
    const untypedBlob = new Blob([new Uint8Array([137, 80])], { type: '' });
    await runOcr(untypedBlob, { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('does not attach endpoint-path advice to an authentication failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    let thrown;
    try {
      await runOcr(
        pngBlob(),
        { mimeType: 'image/png', name: 'a.png' },
        { ...config(), endpoint: 'https://api.example.com/v1' },
        { fetchImpl }
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('AUTHENTICATION_FAILED');
    expect(thrown.hint ?? '').not.toContain('endpoint path');
  });

  it('maps 401 to AUTHENTICATION_FAILED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(
      runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl })
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('maps 429 to retryable RATE_LIMITED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
    await expect(
      runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });

  it('maps fetch rejection (network/CORS) to NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl })
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });

  it('throws PROVIDER_NOT_CONFIGURED without a config', async () => {
    await expect(
      runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, null)
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('rejects non-JSON responses as NOT_JSON_RESPONSE and shows the body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>Not found</html>', { status: 200 }));
    let thrown;
    try {
      await runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('NOT_JSON_RESPONSE');
    expect(thrown.detail).toContain('<html>Not found</html>');
  });

  it('extracts the provider message from a JSON error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }), {
        status: 402,
      })
    );
    let thrown;
    try {
      await runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('INSUFFICIENT_CREDITS');
    expect(thrown.detail).toContain('Insufficient credits');
  });

  it('names the requested model in the details of a parse failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
      );
    let thrown;
    try {
      await runOcr(pngBlob(), { mimeType: 'image/png', name: 'a.png' }, config(), { fetchImpl });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('EMPTY_COMPLETION');
    expect(thrown.detail).toContain('Requested model: test-model');
  });

  it('builds the request against the base URL plus /chat/completions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'hi' } }] })
    );
    await runOcr(
      pngBlob(),
      { mimeType: 'image/png', name: 'a.png' },
      { ...config(), endpoint: 'https://openrouter.ai/api/v1' },
      { fetchImpl }
    );
    expect(fetchImpl.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('reports the resolved request URL in a network-failure detail', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    let thrown;
    try {
      await runOcr(
        pngBlob(),
        { mimeType: 'image/png', name: 'a.png' },
        { ...config(), endpoint: 'https://openrouter.ai/api/v1' },
        { fetchImpl }
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('NETWORK_ERROR');
    expect(thrown.detail).toContain('https://openrouter.ai/api/v1/chat/completions');
  });
});

describe('testProviderConnection', () => {
  it('sends a minimal text-only request and reports the model and reply', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ model: 'test-model', choices: [{ message: { content: 'ok' } }] })
    );
    const result = await testProviderConnection(config(), { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.model).toBe('test-model');
    expect(result.reply).toBe('ok');
    expect(typeof result.elapsedMs).toBe('number');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.response_format).toBeUndefined();
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'Reply with only the single word: ok' },
    ]);
  });

  it('surfaces a classified error when the provider rejects the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(testProviderConnection(config(), { fetchImpl })).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('throws PROVIDER_NOT_CONFIGURED without a config', async () => {
    await expect(testProviderConnection(null)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });
});
