import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown';

afterEach(() => vi.useRealTimers());
describe('ordered bounded shutdown', () => {
  it('drains before worker close and dependency teardown, once for repeated shutdown', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; });
    const worker = { pause: vi.fn(() => { order.push('pause'); return active; }),
      close: vi.fn(async () => { order.push('worker-close'); }) };
    const shutdown = createShutdown({ workers: () => [worker], drainMs: 100,
      markDraining: () => { order.push('draining'); },
      closeQueues: async () => { order.push('queues-close'); },
      closeApplication: async () => { order.push('dependencies-close'); },
      logger: { log: vi.fn(), error: vi.fn() } });
    const first = shutdown('SIGTERM');
    expect(shutdown('SIGINT')).toBe(first);
    expect(order).toEqual(['draining', 'pause']);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['draining', 'pause']);
    finish();
    expect(await first).toBe(true);
    expect(order).toEqual(['draining', 'pause', 'worker-close', 'queues-close', 'dependencies-close']);
    expect(worker.close).toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('expires the drain, force-closes and continues cleanup without leaked timers', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const worker = { pause: () => new Promise<void>((_, r) => { reject = r; }), close: vi.fn(async () => {}) };
    const closeApplication = vi.fn(async () => {});
    const logger = { log: vi.fn(), error: vi.fn() };
    const shutdown = createShutdown({ workers: () => [worker], drainMs: 100,
      markDraining: vi.fn(), closeQueues: vi.fn(async () => {}), closeApplication, logger });
    const result = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(closeApplication).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('drain expired'));
    reject(new Error('late pause rejection'));
    await vi.advanceTimersByTimeAsync(1);
    expect(await shutdown()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never tears down application dependencies while forced worker close is stuck', async () => {
    vi.useFakeTimers();
    const closeApplication = vi.fn(async () => {});
    const closeQueues = vi.fn(async () => {});
    const shutdown = createShutdown({ workers: () => [{ pause: () => new Promise(() => {}),
      close: () => new Promise(() => {}) }], drainMs: 100, cleanupMs: 50,
      markDraining: vi.fn(), closeQueues, closeApplication,
      logger: { log: vi.fn(), error: vi.fn() } });
    const result = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toBe(false);
    expect(closeQueues).not.toHaveBeenCalled();
    expect(closeApplication).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds cleanup even when a dependency never closes', async () => {
    vi.useFakeTimers();
    const shutdown = createShutdown({ workers: () => [], drainMs: 100, cleanupMs: 50,
      markDraining: vi.fn(), closeQueues: vi.fn(async () => {}),
      closeApplication: () => new Promise(() => {}),
      logger: { log: vi.fn(), error: vi.fn() } });
    const result = shutdown();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('continues queue and dependency cleanup if worker close rejects', async () => {
    const closeQueues = vi.fn(async () => {});
    const closeApplication = vi.fn(async () => {});
    const shutdown = createShutdown({ workers: () => [{ pause: async () => {},
      close: async () => { throw new Error('close failed'); } }], drainMs: 100,
      closeQueues, closeApplication, markDraining: vi.fn(),
      logger: { log: vi.fn(), error: vi.fn() } });
    expect(await shutdown()).toBe(false);
    expect(closeQueues).toHaveBeenCalledOnce();
    expect(closeApplication).toHaveBeenCalledOnce();
  });
});
