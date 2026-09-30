import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { BaseQueueProcessor } from './base.processor';

describe('worker failure diagnostics', () => {
  it.each([
    [new UnrecoverableError('configuration missing'), 1, 'giving up'],
    [new Error('temporary failure'), 1, 'retry eligible'],
    [new Error('exhausted'), 3, 'giving up'],
  ])('reports retry eligibility truthfully for %s', (error, attemptsMade, label) => {
    const logger = { error: vi.fn() };
    BaseQueueProcessor.prototype.onFailed.call({ logger } as never, {
      id: 'job-1', name: 'index', attemptsMade, opts: { attempts: 3 },
      data: { traceId: 'trace-1' },
    } as never, error);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(label));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('trace=trace-1'));
  });
});
