import { afterEach, expect, it, vi } from 'vitest';
import { GeminiEmbeddingProvider } from './gemini-embeddings';

afterEach(() => vi.unstubAllGlobals());
const provider = () => new GeminiEmbeddingProvider({ apiKey: 'synthetic-only', model: 'gemini-embedding-2', dimensions: 1536 });

it('requests explicit 1536-D vectors independently and preserves input order', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    expect(body.embedContentConfig).toEqual({ outputDimensionality: 1536, autoTruncate: false });
    return new Response(JSON.stringify({ embedding: { values: Array(1536).fill(body.content.parts[0].text === 'first' ? 1 : 2) } }));
  });
  vi.stubGlobal('fetch', fetch);
  const result = await provider().embed(['first', 'second']);
  expect(result.map((vector) => vector[0])).toEqual([1, 2]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent');
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal),
    headers: { 'x-goog-api-key': 'synthetic-only' } });
});

it.each([401, 429, 500])('withholds provider bodies and makes no implicit retries on HTTP %i', async (status) => {
  const fetch = vi.fn(async () => new Response('SECRET_PROVIDER_MARKER', { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(provider().embed(['fixture'])).rejects.toThrow(`Gemini embedding request failed (HTTP ${status})`);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([[], Array(3072).fill(1), Array(1536).fill(null), Array(1536).fill(0)])(
  'rejects malformed vectors without exposing content', async (values) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embedding: { values }, secret: 'SECRET_PROVIDER_MARKER' }))));
    await expect(provider().embed(['fixture'])).rejects.toThrow('Gemini embedding response violated the vector contract');
  },
);

it('withholds transport and JSON parse errors', async () => {
  for (const fetch of [vi.fn(async () => { throw new Error('SECRET_PROVIDER_MARKER'); }),
    vi.fn(async () => new Response('SECRET_PROVIDER_MARKER'))]) {
    vi.stubGlobal('fetch', fetch);
    const error = await provider().embed(['fixture']).catch((error: Error) => error);
    expect(String(error)).not.toContain('SECRET_PROVIDER_MARKER');
  }
});

it('does not send requests for an empty batch or accept unsupported configuration', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await provider().embed([])).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(() => new GeminiEmbeddingProvider({ apiKey: '', model: 'gemini-embedding-2', dimensions: 1536 })).toThrow('credentials');
  expect(() => new GeminiEmbeddingProvider({ apiKey: 'synthetic-only', model: '../wrong', dimensions: 1536 })).toThrow('Unsupported');
});
