import { afterEach, expect, it, vi } from 'vitest';
import { OpenAiProvider, AnthropicProvider } from './providers';
import { classifyAiFailure } from './ai-errors';

afterEach(() => vi.unstubAllGlobals());
it('keeps hypothetical native function calls outside the JSON-content contract', async () => {
  // Synthetic structure, not an assertion about the discarded real response body.
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    model: 'synthetic',
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
      id: 'correlation-only', type: 'function', function: {
        name: 'read_repository_metadata', arguments: '{}',
      },
    }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
  })));
  vi.stubGlobal('fetch', fetch);
  const result = await new OpenAiProvider({ apiKey: 'synthetic-only', model: 'synthetic' })
    .complete({ messages: [], jsonMode: true, retryAttempts: 1 });
  expect(result).toMatchObject({ content: '', finishReason: 'tool_calls' });
  expect(result).not.toHaveProperty('toolCalls');
  const request = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(request.response_format).toEqual({ type: 'json_object' });
  expect(request).not.toHaveProperty('tools');
  expect(request).not.toHaveProperty('tool_choice');
});
it.each([OpenAiProvider, AnthropicProvider])('lets bounded orchestration reserve each transport without hidden retries', async (Provider) => {
  const fetch = vi.fn(async () => new Response('{}', { status: 429 }));
  vi.stubGlobal('fetch', fetch);
  await expect(new Provider({ apiKey: 'synthetic-only', model: 'synthetic' })
    .complete({ messages: [], retryAttempts: 1 })).rejects.toThrow('429');
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([OpenAiProvider, AnthropicProvider])('passes transport abort signal without converting it into a retry', async (Provider) => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_url, options) => {
    expect(options.signal).toBe(controller.signal);
    throw new DOMException('aborted', 'AbortError');
  });
  vi.stubGlobal('fetch', fetch);
  await expect(new Provider({ apiKey: 'synthetic-only', model: 'synthetic' })
    .complete({ messages: [], retryAttempts: 1, signal: controller.signal })).rejects.toMatchObject({name: 'AbortError'});
  expect(fetch).toHaveBeenCalledOnce();
});
it('routes Gemini-compatible reviews to Google and identifies model failures as Gemini', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'SECRET_PROVIDER_MARKER' } }), { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const provider = new OpenAiProvider({ apiKey: 'synthetic-gemini-key', model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
  expect(provider.name).toBe('GEMINI');
  const error = await provider.complete({ messages: [] }).catch((error: Error) => error);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]).toEqual([
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-gemini-key' }) }),
  ]);
  const classified = classifyAiFailure(error);
  expect(classified.kind).toBe('MODEL_NOT_FOUND');
  expect(classified.message).toContain('GEMINI (HTTP 404)');
  expect(classified.message).not.toContain('OPENAI');
  expect(classified.message).not.toContain('SECRET_PROVIDER_MARKER');
});
it('preserves OpenAI identity for OpenAI URLs and does not trust lookalike hosts', () => {
  for (const baseUrl of [undefined, 'https://api.openai.com/v1',
    'https://generativelanguage.googleapis.com.example/v1beta/openai']) {
    expect(new OpenAiProvider({ apiKey: 'synthetic-only', model: 'synthetic', baseUrl }).name).toBe('OPENAI');
  }
});
it.each([OpenAiProvider, AnthropicProvider])('withholds response secrets even in identifier-shaped error codes', async (Provider) => {
  const marker = 'SECRET_PROVIDER_MARKER';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: marker, code: marker, type: marker } }), { status: 401 })));
  const provider = new Provider({ apiKey: 'synthetic-only', model: 'synthetic' });
  const error = await provider.complete({ messages: [{ role: 'user', content: 'fixture' }] }).catch((error: Error) => error);
  expect(String(error)).toContain('401');
  expect(String(error)).not.toContain(marker);
  expect(JSON.stringify(error)).not.toContain(marker);
});
it('withholds transport errors and keeps safe provider categories useful', async () => {
  const provider = new OpenAiProvider({ apiKey: 'synthetic-only', model: 'synthetic' });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('SECRET_PROVIDER_MARKER'); }));
  const transport = await provider.complete({ messages: [] }).catch((error: Error) => error);
  expect(String(transport)).not.toContain('SECRET_PROVIDER_MARKER');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'SECRET_PROVIDER_MARKER', code: 'invalid_api_key' } }), { status: 401 })));
  const rejected = await provider.complete({ messages: [] }).catch((error: Error) => error);
  expect(String(rejected)).toContain('invalid_api_key');
  expect(String(rejected)).not.toContain('SECRET_PROVIDER_MARKER');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('SECRET_PROVIDER_MARKER')));
  const malformed = await provider.complete({ messages: [] }).catch((error: Error) => error);
  expect(String(malformed)).not.toContain('SECRET_PROVIDER_MARKER');
});
