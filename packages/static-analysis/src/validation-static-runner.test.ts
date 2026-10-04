import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ mode: 'error', options: null as any, terminated: 0 }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    stdout = { resume() {} };
    stderr = { resume() {} };
    constructor(_path: string, options: any) {
      super();
      mock.options = options;
      queueMicrotask(() => {
        if (mock.mode === 'error') this.emit('error', new Error('sensitive internal message'));
      });
    }
    async terminate() {
      mock.terminated++;
      if (mock.mode === 'termination-error') throw new Error('sensitive termination message');
      return 0;
    }
  },
}));
import { runValidationStatic } from './validation-static-runner';
afterEach(() => {
  vi.useRealTimers();
  mock.mode = 'error';
  mock.options = null;
  mock.terminated = 0;
});
it('termination rejection is handled without emitting internal error details', async () => {
  mock.mode = 'termination-error';
  const abort = new AbortController();
  const result = runValidationStatic(sources, [], abort.signal);
  const rejected = expect(result).rejects.toThrow('STATIC_WORKER_TERMINATION_FAILED');
  abort.abort();
  await rejected;
  expect(mock.terminated).toBe(1);
});
const sources = {
  ORIGINAL: [{ path: 'src/a.ts', content: 'eval(input);' }],
  PATCHED: [{ path: 'src/a.ts', content: 'eval(input);' }],
};
it('worker failure is explicit, credential-free, source-free and resource-bounded', async () => {
  const result = await runValidationStatic(sources, [], new AbortController().signal);
  expect(result.ORIGINAL.status).toBe('FAILED');
  expect(result.ORIGINAL.findings).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('sensitive');
  expect(mock.options.env).toEqual({});
  expect(mock.options.execArgv).toEqual([]);
  expect(mock.options.resourceLimits.maxOldGenerationSizeMb).toBe(64);
  expect(mock.terminated).toBe(1);
});
it('time bound terminates computation, not a non-cancelling Promise.race', async () => {
  vi.useFakeTimers();
  mock.mode = 'stall';
  const result = runValidationStatic(sources, [], new AbortController().signal);
  await vi.advanceTimersByTimeAsync(5001);
  expect((await result).ORIGINAL.status).toBe('TIMED_OUT');
  expect(mock.terminated).toBe(1);
});
it('cancellation terminates analyzer and prevents late result acceptance', async () => {
  mock.mode = 'stall';
  const abort = new AbortController();
  const result = runValidationStatic(sources, [], abort.signal);
  const rejected = expect(result).rejects.toThrow('STATIC_CANCELLED');
  abort.abort();
  await rejected;
  expect(mock.terminated).toBe(1);
});
it('oversized source is unsupported before any worker is started', async () => {
  const result = await runValidationStatic(
    { ...sources, PATCHED: [{ path: 'src/a.ts', content: 'x'.repeat(2001) }] },
    [],
    new AbortController().signal,
  );
  expect(result.PATCHED.status).toBe('UNSUPPORTED');
  expect(mock.options).toBeNull();
});
