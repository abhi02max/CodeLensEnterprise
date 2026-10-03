import { describe, expect, it, vi } from 'vitest';
import { PROMPT_VERSION, Role } from '@codelens/shared';
import { RunTrigger } from '@codelens/database';
import { QueueService } from './queue.service';
import { JOB_IDS } from './queue.types';

const data = {
  organizationId: 'org-1', pullRequestId: 'pr-1', repositoryId: 'repo-1',
  headSha: 'head-1', userId: 'user-1', userRole: Role.REVIEWER,
  traceId: 'trace-1', trigger: RunTrigger.USER, force: false, postToGithub: false,
};

function job(runId: string, state: 'completed' | 'active') {
  return {
    id: JOB_IDS.analyze(data.pullRequestId, data.headSha, PROMPT_VERSION, 1, runId),
    name: 'analyze-pull-request',
    data, progress: 0, opts: { attempts: 1 }, attemptsMade: 1,
    timestamp: Date.now(), processedOn: Date.now(),
    finishedOn: state === 'completed' ? Date.now() : null,
    returnvalue: state === 'completed' ? { reviewRunId: runId, reused: true } : null,
    failedReason: null, getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('analysis job deduplication', () => {
  it('collaboration replay retains failed/completed jobs and explicit attempts get distinct IDs', async () => {
    const queue = { getJob: vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue('failed'), remove: vi.fn() }), add: vi.fn() };
    const service = new QueueService(queue as never, queue as never, queue as never,
      { queue: { maxAttempts: 2 } } as never, queue as never);
    const request = { organizationId: 'org', userId: 'user', traceId: 'trace', turnId: 'turn', attempt: 1 };
    await service.enqueueCollaboration(request);
    expect(queue.getJob).toHaveBeenCalledWith('collaborate-turn-1');
    expect(queue.add).not.toHaveBeenCalled();
    queue.getJob.mockResolvedValue(null);
    await service.enqueueCollaboration({ ...request, attempt: 2 });
    expect(queue.add).toHaveBeenCalledWith('collaborate', expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ jobId: 'collaborate-turn-2', attempts: 1 }));
  });
  it('keeps a completed job when it already points at the authoritative run', async () => {
    const existing = job('run-new', 'completed');
    const queue = { getJob: vi.fn().mockResolvedValue(existing), add: vi.fn() };
    const service = new QueueService(queue as never, queue as never, queue as never,
      { queue: { maxAttempts: 2 } } as never, queue as never);

    const result = await service.enqueueAnalysis(data, 'run-new');
    expect(result).toMatchObject({ deduplicated: true, reviewRunId: 'run-new', state: 'COMPLETED' });
    expect(existing.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('uses a new ID after a newer generation without deleting the old job', async () => {
    const old = job('run-old', 'completed');
    const next = job('run-new', 'completed');
    const queue = { getJob: vi.fn().mockResolvedValue(null), add: vi.fn().mockResolvedValue(next) };
    const service = new QueueService(queue as never, queue as never, queue as never,
      { queue: { maxAttempts: 2 } } as never, queue as never);

    const result = await service.enqueueAnalysis(data, 'run-new');
    expect(queue.getJob).toHaveBeenCalledWith(next.id);
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), data,
      expect.objectContaining({ jobId: next.id }));
    expect(old.remove).not.toHaveBeenCalled();
    expect(result.deduplicated).toBe(false);
  });

  it('deduplicates an active job for the same input generation', async () => {
    const active = job('run-old', 'active');
    const queue = { getJob: vi.fn().mockResolvedValue(active), add: vi.fn() };
    const service = new QueueService(queue as never, queue as never, queue as never,
      { queue: { maxAttempts: 2 } } as never, queue as never);

    const result = await service.enqueueAnalysis(data, 'run-old');
    expect(result).toMatchObject({ deduplicated: true, state: 'ACTIVE' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('changes IDs with prompt/schema version and every explicit force', () => {
    expect(JOB_IDS.analyze('pr', 'head', 'v2', 1, null))
      .not.toBe(JOB_IDS.analyze('pr', 'head', 'v1', 1, null));
    expect(JOB_IDS.analyze('pr', 'head', 'v1', 2, null))
      .not.toBe(JOB_IDS.analyze('pr', 'head', 'v1', 1, null));
    expect(JOB_IDS.analyzeForced('pr', 'head'))
      .not.toBe(JOB_IDS.analyzeForced('pr', 'head'));
  });
});
