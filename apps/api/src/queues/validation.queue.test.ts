import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ValidationJobSchema, ValidationQueue } from './validation.queue';

it('coalesces identifier-only queue requests and disables automatic execution retry', async () => {
  const add = vi.fn(async () => ({})),
    queue = new ValidationQueue({ add } as never);
  const data = { organizationId: 'org', validationId: randomUUID(), attemptId: randomUUID() };
  await Promise.all([queue.enqueue('validation-job', data), queue.enqueue('validation-job', data)]);
  expect(add).toHaveBeenCalledTimes(1);
  expect(add.mock.calls[0]).toEqual([
    'paired-validation',
    data,
    { jobId: 'validation-job', attempts: 1, removeOnComplete: false, removeOnFail: false },
  ]);
});
it('rejects source, execution policy and arbitrary job fields', () => {
  const data = { organizationId: 'org', validationId: randomUUID(), attemptId: randomUUID() };
  for (const field of ['source', 'image', 'command', 'env', 'network', 'fence'])
    expect(() => ValidationJobSchema.parse({ ...data, [field]: 'injected' })).toThrow();
});
