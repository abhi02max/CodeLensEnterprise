import { expect, it, vi } from 'vitest';
import { ValidationAiQueue, ValidationAiJobSchema } from './validation-ai.queue';
it('transports persistent identity only, coalesces enqueue and has no automatic retry', async () => {
  let release!: (v: unknown) => void;
  const add = vi.fn(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const q = new ValidationAiQueue({ add } as never),
    id = '00000000-0000-4000-8000-000000000001';
  const a = q.enqueue(id),
    b = q.enqueue(id);
  expect(add).toHaveBeenCalledOnce();
  expect(add.mock.calls[0]).toEqual([
    'rereview',
    { reviewId: id },
    { jobId: 'validation-ai-' + id, attempts: 1, removeOnComplete: false, removeOnFail: false },
  ]);
  release({});
  await Promise.all([a, b]);
  expect(() => ValidationAiJobSchema.parse({ reviewId: id, prompt: 'injected' })).toThrow();
});
