import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisService } from './redis.service';

afterEach(() => vi.restoreAllMocks());

describe('analysis lock ownership', () => {
  it('releases only the token that still owns the key', async () => {
    const service = new RedisService({ redisUrl: 'redis://127.0.0.1:1' } as never);
    let owner: string | null = null;
    vi.spyOn(service.client, 'set').mockImplementation(async (_key, value) => {
      owner = String(value);
      return 'OK';
    });
    const evaluate = vi.spyOn(service.client, 'eval').mockImplementation(async (_script, _count, _key, token) => {
      if (owner !== token) return 0;
      owner = null;
      return 1;
    });

    const first = await service.acquireLock('analysis:lock:test', 900);
    const second = await service.acquireLock('analysis:lock:test', 900);
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    await service.releaseLock('analysis:lock:test', first!);
    expect(owner).toBe(second);
    await service.releaseLock('analysis:lock:test', second!);
    expect(owner).toBeNull();
    expect(evaluate.mock.calls[0][0]).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
  });
  it('does not mask the caller result when release fails', async () => {
    const service = new RedisService({ redisUrl: 'redis://127.0.0.1:1' } as never);
    vi.spyOn(service.client, 'eval').mockRejectedValue(new Error('connection lost'));
    await expect(service.releaseLock('analysis:lock:test', 'owner-token')).resolves.toBeUndefined();
  });
});
