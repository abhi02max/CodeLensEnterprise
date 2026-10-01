import { describe, expect, it, vi } from 'vitest';
import { Role, ReviewRunStatus } from '@codelens/shared';
import { RunTrigger } from '@codelens/database';
import { authoritativeRunId } from './analysis-report.service';
import { AnalysisService } from './analysis.service';
import type { PrismaService } from '../prisma/prisma.service';

const pr = {
  id: 'pr-1', number: 412, headSha: 'head-new', repositoryId: 'repo-1',
  repository: { fullName: 'acme/payments' },
};

function db(findRun: ReturnType<typeof vi.fn>) {
  return {
    unscoped: {
      pullRequest: { findFirst: vi.fn().mockResolvedValue(pr) },
      reviewRun: { findFirst: findRun },
    },
  } as unknown as PrismaService;
}

describe('authoritative review run', () => {
  it('prefers current-head usable evidence over a newer failed attempt', async () => {
    const findRun = vi.fn().mockResolvedValueOnce({ id: 'forced-complete' });
    expect(await authoritativeRunId(db(findRun), 'org-1', pr.id, pr.headSha))
      .toBe('forced-complete');
    expect(findRun.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1', pullRequestId: pr.id, headSha: pr.headSha,
      status: { in: ['COMPLETED', 'PARTIAL'] },
    });
  });

  it('falls back to a current attempt, then to explicitly stale history', async () => {
    const current = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'running' });
    expect(await authoritativeRunId(db(current), 'org-1', pr.id, pr.headSha)).toBe('running');
    expect(current).toHaveBeenCalledTimes(2);

    const historical = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'old-head' });
    expect(await authoritativeRunId(db(historical), 'org-1', pr.id, pr.headSha)).toBe('old-head');
    expect(historical.mock.calls[2][0].where).not.toHaveProperty('headSha');
  });

  it('reuses the newest completed generation, including a forced one', async () => {
    const findRun = vi.fn().mockResolvedValue({ id: 'forced-complete', status: ReviewRunStatus.COMPLETED });
    const prisma = db(findRun);
    const service = new AnalysisService(
      prisma, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never,
    );
    const result = await service.run({
      organizationId: 'org-1', pullRequestId: pr.id, userId: 'user-1',
      userRole: Role.REVIEWER, traceId: 'trace-1', trigger: RunTrigger.USER,
      force: false, postToGithub: false,
    });
    expect(result).toMatchObject({ reviewRunId: 'forced-complete', reused: true });
    expect(findRun.mock.calls[0][0].where).toMatchObject({
      headSha: pr.headSha, promptVersion: expect.any(String), featureSchemaVersion: 1,
    });
  });

  it('rejects a queued job after the head has moved', async () => {
    const service = new AnalysisService(
      db(vi.fn()), {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    await expect(service.run({
      organizationId: 'org-1', pullRequestId: pr.id, userId: 'user-1',
      userRole: Role.REVIEWER, traceId: 'trace-1', trigger: RunTrigger.USER,
      force: false, postToGithub: false, headSha: 'head-old',
    })).rejects.toThrow(/head changed/);
  });

  it('releases the analysis lock when run creation fails before pipeline execution', async () => {
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const prisma = db(vi.fn()) as PrismaService & { unscoped: any };
    prisma.unscoped.reviewRun.findUnique = vi.fn().mockResolvedValue(null);
    prisma.unscoped.reviewRun.create = vi.fn().mockRejectedValue(new Error('database write failed'));
    const service = new AnalysisService(prisma,
      { consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
        acquireLock: vi.fn().mockResolvedValue('owner-token'), releaseLock } as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.run({ organizationId: 'org-1', pullRequestId: pr.id,
      userId: 'user-1', userRole: Role.REVIEWER, traceId: 'trace-1',
      trigger: RunTrigger.USER, force: true, postToGithub: false,
    })).rejects.toThrow('database write failed');
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.stringContaining('analysis:lock:'), 'owner-token');
  });

  it('marks a created ReviewRun failed when pre-pipeline setup rejects', async () => {
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue({});
    const prisma = db(vi.fn()) as PrismaService & { unscoped: any };
    prisma.unscoped.reviewRun.findUnique = vi.fn().mockResolvedValue(null);
    prisma.unscoped.reviewRun.create = vi.fn().mockResolvedValue({ id: 'run-1' });
    prisma.unscoped.reviewRun.update = update;
    const service = new AnalysisService(prisma,
      { consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
        acquireLock: vi.fn().mockResolvedValue('owner-token'), releaseLock } as never,
      {} as never, { record: vi.fn().mockResolvedValue(undefined) } as never,
      { getAiSettings: vi.fn().mockRejectedValue(new Error('policy unavailable')) } as never,
      {} as never, { create: vi.fn(), release: vi.fn() } as never, {} as never);
    await expect(service.run({ organizationId: 'org-1', pullRequestId: pr.id,
      userId: 'user-1', userRole: Role.REVIEWER, traceId: 'trace-1',
      trigger: RunTrigger.USER, force: true, postToGithub: false,
    })).rejects.toThrow('policy unavailable');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1' }, data: expect.objectContaining({ status: ReviewRunStatus.FAILED }),
    }));
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.stringContaining('analysis:lock:'), 'owner-token');
  });

  it('keys queued work to the latest terminal generation for this head and version', async () => {
    const findRun = vi.fn().mockResolvedValue({ id: 'latest-terminal' });
    const enqueueAnalysis = vi.fn().mockResolvedValue({ id: 'job-1' });
    const service = new AnalysisService(
      db(findRun), {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never,
      { enqueueAnalysis } as never,
    );
    await service.enqueue({
      organizationId: 'org-1', pullRequestId: pr.id, userId: 'user-1',
      userRole: Role.REVIEWER, traceId: 'trace-1', trigger: RunTrigger.USER,
      force: false, postToGithub: false,
    });
    expect(findRun.mock.calls[0][0].where).toMatchObject({
      headSha: pr.headSha, promptVersion: expect.any(String),
      featureSchemaVersion: 1,
      status: { in: ['COMPLETED', 'PARTIAL', 'FAILED'] },
    });
    expect(enqueueAnalysis).toHaveBeenCalledWith(expect.objectContaining({ headSha: pr.headSha }),
      'latest-terminal');
  });
});
