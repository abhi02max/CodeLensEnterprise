import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service';

function service(
  redis: () => Promise<unknown>,
  stats: () => Promise<unknown> = async () => [],
  configured = false,
) {
  return new HealthService(
    { isHealthy: async () => ({ ok: true, latencyMs: 0 }) } as never,
    { isHealthy: redis } as never,
    {
      ai: { configured, provider: 'openai', model: 'test-model' },
      ml: { url: 'http://ml', timeoutMs: 100 },
    } as never,
    { stats } as never,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded readiness', () => {
  it('reports down immediately once shutdown draining begins', async () => {
    const check = service(vi.fn(), vi.fn());
    check.markDraining();
    expect(await check.overall()).toMatchObject({
      status: 'down', checks: [{ name: 'shutdown', ok: false, required: true }],
    });
  });
  it('reports a hung required Redis probe as down', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const pending = service(() => new Promise(() => {})).overall();
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.status).toBe('down');
    expect(result.checks.find((check) => check.name === 'redis')).toMatchObject({
      ok: false,
      required: true,
      detail: 'Health probe timed out',
    });
  });

  it('reports a hung optional queue probe as degraded, not down', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const pending = service(
      async () => ({ ok: true, latencyMs: 0 }),
      () => new Promise(() => {}),
    ).overall();
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.status).toBe('degraded');
    expect(result.checks.find((check) => check.name === 'queues')).toMatchObject({
      ok: false,
      required: false,
    });
  });

  it('does not claim a configured provider is reachable', () => {
    const health = service(async () => ({ ok: true, latencyMs: 0 }), undefined, true);
    expect(health.aiHealth().ok).toBe(true);
    expect(health.aiHealth().detail).toContain('provider reachability not checked');
  });

  it('does not accumulate commands after timeout and retries after late settlement', async () => {
    vi.useFakeTimers();
    let finish!: (value: { ok: boolean; latencyMs: number }) => void;
    const redis = vi.fn(
      () =>
        new Promise<{ ok: boolean; latencyMs: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const health = service(redis);
    const first = health.redisHealth();
    await vi.advanceTimersByTimeAsync(5001);
    expect((await first).ok).toBe(false);
    for (let i = 0; i < 20; i++) expect((await health.redisHealth()).ok).toBe(false);
    expect(redis).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    finish({ ok: true, latencyMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    redis.mockResolvedValue({ ok: true, latencyMs: 0 });
    expect((await health.redisHealth()).ok).toBe(true);
    expect(redis).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles late rejection without retaining a failed probe', async () => {
    vi.useFakeTimers();
    let fail!: (reason: Error) => void;
    const redis = vi.fn(
      () =>
        new Promise<{ ok: boolean; latencyMs: number }>((_, reject) => {
          fail = reject;
        }),
    );
    const health = service(redis);
    const first = health.redisHealth();
    await vi.advanceTimersByTimeAsync(5001);
    await first;
    fail(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    redis.mockResolvedValue({ ok: true, latencyMs: 0 });
    expect((await health.redisHealth()).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
