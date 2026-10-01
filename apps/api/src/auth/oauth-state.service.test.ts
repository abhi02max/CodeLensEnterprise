import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthStateService } from './oauth-state.service';

const context = { linkToUserId: 'user-a', organizationId: 'org-a', tokenGeneration: 1 };
function fixture() {
  const records = new Map<string, string>();
  const client = {
    set: vi.fn(async (key: string, value: string) => { records.set(key, value); return 'OK'; }),
    eval: vi.fn(async (_script: string, _count: number, key: string, binding: string) => {
      const raw = records.get(key);
      if (!raw || JSON.parse(raw).binding !== binding) return null;
      records.delete(key);
      return raw;
    }),
  };
  const service = new OAuthStateService({ client } as never, { jwtSecret: 'synthetic-signing-secret' } as never);
  return { service, records, client };
}

beforeEach(() => vi.useRealTimers());
describe('browser/session-bound OAuth state', () => {
  it('accepts once, returns server-side identity, and rejects exact replay', async () => {
    const { service } = fixture();
    const issued = await service.issue(context, 'session-a');
    expect(await service.consume(issued.state, issued.browser, 'session-a')).toEqual(context);
    await expect(service.consume(issued.state, issued.browser, 'session-a')).rejects.toThrow();
  });
  it('rejects wrong browser and wrong local session without consuming the legitimate state', async () => {
    const { service } = fixture();
    const issued = await service.issue(context, 'session-a');
    const other = await service.issue({ ...context, linkToUserId: 'user-b' }, 'session-b');
    await expect(service.consume(issued.state, other.browser, 'session-a')).rejects.toThrow();
    await expect(service.consume(issued.state, issued.browser, 'session-b')).rejects.toThrow();
    expect(await service.consume(issued.state, issued.browser, 'session-a')).toEqual(context);
  });
  it('rejects missing, tampered, expired and unknown state', async () => {
    const { service, records } = fixture();
    const issued = await service.issue(context, undefined);
    await expect(service.consume(undefined, issued.browser, undefined)).rejects.toThrow();
    await expect(service.consume(issued.state, undefined, undefined)).rejects.toThrow();
    await expect(service.consume(`${issued.state}tampered`, issued.browser, undefined)).rejects.toThrow();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
    await expect(service.consume(issued.state, issued.browser, undefined)).rejects.toThrow();
    vi.restoreAllMocks();
    records.clear();
    await expect(service.consume(issued.state, issued.browser, undefined)).rejects.toThrow();
  });
  it('permits only one concurrent consumer and uses a single atomic command', async () => {
    const { service, client } = fixture();
    const issued = await service.issue(context, undefined);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => service.consume(issued.state, issued.browser, undefined)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(client.eval.mock.calls[0]?.[0]).toContain("redis.call('DEL', KEYS[1])");
  });
  it('fails closed on Redis errors instead of issuing usable state', async () => {
    const { service, client } = fixture();
    client.set.mockRejectedValue(new Error('offline'));
    await expect(service.issue(context, undefined)).rejects.toThrow('offline');
  });
});
