import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, OpenAiProvider } from './providers';
afterEach(() => vi.unstubAllGlobals());
it.each([200, 429, 500])(
  'bounds streamed HTTP %s bodies without leaking their contents',
  async (status) => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('synthetic-private-marker'.repeat(1000)));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          ),
      ),
    );
    const p = new OpenAiProvider({ model: 'test', apiKey: 'synthetic-key' });
    await expect(
      p.complete({ messages: [], maxResponseBytes: 16384, retryAttempts: 1 }),
    ).rejects.toMatchObject({ detail: 'RESPONSE_BOUND', retryable: false });
    expect(cancelled).toBe(true);
  },
);
it('preserves unknown versus explicitly reported zero OpenAI usage', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        model: 'test',
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        model: 'test',
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const p = new OpenAiProvider({ model: 'test', apiKey: 'synthetic-key' });
  expect(
    (await p.complete({ messages: [], maxResponseBytes: 16384, retryAttempts: 1 })).usageReported,
  ).toBe(false);
  expect(
    (await p.complete({ messages: [], maxResponseBytes: 16384, retryAttempts: 1 })).usageReported,
  ).toBe(true);
});
it('bounds Anthropic responses and records usage availability without native tools', async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      model: 'test',
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const p = new AnthropicProvider({ model: 'test', apiKey: 'synthetic-key' });
  expect(
    (await p.complete({ messages: [], maxResponseBytes: 16384, retryAttempts: 1, jsonMode: true }))
      .usageReported,
  ).toBe(false);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty('tools');
});
it('aborts stalled response-body reads', async () => {
  const signal = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{'));
            },
          }),
        ),
    ),
  );
  const p = new OpenAiProvider({ model: 'test', apiKey: 'synthetic-key' });
  const call = p.complete({
    messages: [],
    maxResponseBytes: 16384,
    retryAttempts: 1,
    signal: signal.signal,
  });
  await new Promise((r) => setTimeout(r, 10));
  signal.abort();
  await expect(call).rejects.toThrow();
});
