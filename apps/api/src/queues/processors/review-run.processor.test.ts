import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
// Keep application bootstrap/config validation out of this focused processor test.
vi.mock('../../analysis/analysis.service', () => ({ AnalysisService: class {} }));
vi.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
vi.mock('../queue.service', () => ({ classifyJobError: (error: unknown) => error }));
import { ReviewRunProcessor } from './review-run.processor';

describe('abandoned analysis terminal cleanup', () => {
  it.each([
    [new Error('transient'), 1, false],
    [new Error('final'), 2, true],
    [new UnrecoverableError('terminal'), 1, true],
  ])('cleans only terminal failures: %s', async (error, attemptsMade, terminal) => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const processor = new ReviewRunProcessor({} as never, {} as never,
      { unscoped: { reviewRun: { updateMany } } } as never);
    await processor.onJobExhausted({ attemptsMade, opts: { attempts: 2 },
      progress: { reviewRunId: 'run-1' }, id: 'job-1' } as never, error);
    expect(updateMany).toHaveBeenCalledTimes(terminal ? 1 : 0);
    if (terminal) expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', status: 'RUNNING' }, data: expect.objectContaining({ status: 'FAILED' }),
    }));
    if (terminal) expect(updateMany.mock.calls[0][0].data.error).not.toContain('worker process');
  });
  it('returns successful execution without failure cleanup', async () => {
    const updateMany = vi.fn();
    const run = vi.fn(async () => ({ reviewRunId: 'run-1', status: 'COMPLETED', reused: false, degradation: [] }));
    const processor = new ReviewRunProcessor({} as never, { run } as never,
      { unscoped: { reviewRun: { updateMany } } } as never);
    const result = await processor.process({ data: {}, updateProgress: vi.fn() } as never);
    expect(result.status).toBe('COMPLETED');
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('retains and closes a prior active run before a retried attempt', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const updateProgress = vi.fn(async () => {});
    const run = vi.fn(async () => ({ reviewRunId: 'run-2', status: 'COMPLETED',
      reused: false, degradation: [] }));
    const processor = new ReviewRunProcessor({} as never, { run } as never,
      { unscoped: { reviewRun: { updateMany } } } as never);
    await processor.process({ data: { organizationId: 'org-1' },
      progress: { reviewRunId: 'run-1' }, updateProgress } as never);
    expect(updateProgress.mock.calls[0][0]).toMatchObject({ reviewRunId: 'run-1' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', organizationId: 'org-1', status: 'RUNNING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(run).toHaveBeenCalledOnce();
  });
});
