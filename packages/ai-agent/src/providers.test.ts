import { afterEach, expect, it, vi } from 'vitest';
import { OpenAiProvider, AnthropicProvider } from './providers';

afterEach(() => vi.unstubAllGlobals());
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
