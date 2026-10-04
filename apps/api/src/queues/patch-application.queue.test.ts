import { afterEach, expect, it, vi } from 'vitest';
import { PatchApplicationQueue } from './patch-application.queue';
import { applicationRead } from '../collaboration/patch-application-deadline';

afterEach(() => vi.useRealTimers());
const data = { organizationId: 'org', applicationId: 'app', attemptId: 'attempt' };
it('retains deterministic jobs and disables infrastructure retries', async () => {
  const add = vi.fn(async () => ({})),
    producer = new PatchApplicationQueue({ add } as never);
  await producer.enqueue('patch-application-app-1', data);
  expect(add).toHaveBeenCalledWith('materialize', data, {
    jobId: 'patch-application-app-1',
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
});
it('bounds Redis outage waits and coalesces late unsettled enqueue operations', async () => {
  vi.useFakeTimers();
  let settle!: (value: unknown) => void;
  const add = vi.fn(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const producer = new PatchApplicationQueue({ add } as never);
  const first = expect(producer.enqueue('job', data)).rejects.toThrow('TIMEOUT');
  const second = expect(producer.enqueue('job', data)).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(2000);
  await first;
  await second;
  expect(add).toHaveBeenCalledTimes(1);
  const third = producer.enqueue('job', data);
  settle({});
  await third;
  expect(add).toHaveBeenCalledTimes(1);
});
it('limits pending Redis operations rather than accumulating outage promises', async () => {
  vi.useFakeTimers();
  const producer = new PatchApplicationQueue({ add: () => new Promise(() => undefined) } as never);
  const waiting = Array.from({ length: 50 }, (_, n) =>
    expect(producer.enqueue('job-' + n, data)).rejects.toThrow('TIMEOUT'),
  );
  await expect(producer.enqueue('overflow', data)).rejects.toThrow('BUSY');
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all(waiting);
});
it('aborts dependency waits and consumes late rejection without reviving work', async () => {
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  const wait = applicationRead(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
    controller.signal,
  );
  const rejected = expect(wait).rejects.toThrow('ABORTED');
  controller.abort();
  await rejected;
  reject(new Error('late private diagnostic'));
  await Promise.resolve();
});
it('bounds stalled read waits and clears timers/listeners on success', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  expect(await applicationRead(Promise.resolve('safe'), controller.signal)).toBe('safe');
  expect(vi.getTimerCount()).toBe(0);
  const failed = expect(
    applicationRead(new Promise(() => undefined), controller.signal, 100),
  ).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});
