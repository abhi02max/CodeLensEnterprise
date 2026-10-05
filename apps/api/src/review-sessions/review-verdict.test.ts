import { describe, expect, it, vi } from 'vitest';
import { Role, SubmitReviewSchema } from '@codelens/shared';
import { ReviewVerdict } from '@codelens/database';
import { AuditService } from '../audit-logs/audit.service';
import { ReviewSessionsService } from './review-sessions.service';

const head = 'a'.repeat(40);
const input = SubmitReviewSchema.parse({ verdict: 'APPROVED', expectedHeadSha: head });
function fixture() {
  const pr = {
    id: 'pr',
    organizationId: 'org',
    headSha: head,
    authorUserId: null as string | null,
    merged: false,
    wasRisky: null,
    firstReviewedAt: null,
    githubCreatedAt: null,
    repository: { fullName: 'test/repo' },
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    pullRequest: {
      findFirst: vi.fn(async ({ where }) => (where.organizationId === 'org' ? pr : null)),
      update: vi.fn(),
    },
    review: {
      upsert: vi.fn(async ({ create }) => ({
        id: 'review',
        ...create,
        createdAt: new Date(),
        updatedAt: new Date(),
        reviewer: { id: 'user', name: 'Reviewer', avatarUrl: null },
      })),
      count: vi.fn(async () => 0),
    },
    auditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
  };
  const prisma = { unscoped: db, $transaction: vi.fn(async (fn) => fn(db)) };
  const audit = new AuditService(prisma as never);
  const policy = {
    getPolicy: vi.fn(async () => ({
      githubCommentMinRole: Role.ADMIN,
      minApprovals: 1,
      blockingSeverities: [],
      gateRiskThreshold: 80,
    })),
  };
  const service = new ReviewSessionsService(
    prisma as never,
    audit,
    policy as never,
    { getLatest: vi.fn(async () => ({ analyzed: false, findings: [] })) } as never,
    {
      listForPullRequest: vi.fn(async () => []),
      resolvedFingerprintsOf: vi.fn(() => new Set()),
    } as never,
    {} as never,
  );
  vi.spyOn(service, 'listReviews').mockResolvedValue([]);
  const params = {
    organizationId: 'org',
    pullRequestId: 'pr',
    userId: 'user',
    role: Role.REVIEWER,
    verdict: ReviewVerdict.APPROVED,
    input,
    traceId: 'trace',
    ipAddress: null,
    userAgent: null,
  };
  return { db, pr, prisma, audit, service, params };
}

describe('displayed-head human verdict', () => {
  it.each([undefined, '', 'abc', 'a'.repeat(39), 'a'.repeat(41), '../main', 'g'.repeat(40)])(
    'rejects malformed/missing expected head %s',
    (expectedHeadSha) => {
      expect(SubmitReviewSchema.safeParse({ verdict: 'APPROVED', expectedHeadSha }).success).toBe(
        false,
      );
    },
  );
  it('persists the displayed head and critical audit inside the same transaction before feedback', async () => {
    const f = fixture();
    const result = await f.service.submitVerdict(f.params);
    expect(result.review.headSha).toBe(head);
    expect(f.db.$queryRaw).toHaveBeenCalledOnce();
    expect(f.db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resourceId: 'review',
          actorId: 'user',
          metadata: expect.objectContaining({ headSha: head }),
        }),
      }),
    );
    expect(f.db.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.db.pullRequest.update.mock.invocationCallOrder[0],
    );
  });
  it('fails stale head with 409, without review, audit or feedback writes', async () => {
    const f = fixture();
    f.pr.headSha = 'b'.repeat(40);
    await expect(f.service.submitVerdict(f.params)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'HEAD_CHANGED' },
    });
    expect(f.db.review.upsert).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).not.toHaveBeenCalled();
    expect(f.db.pullRequest.update).not.toHaveBeenCalled();
  });
  it('requires full SHA even on direct service invocation', async () => {
    const f = fixture();
    await expect(
      f.service.submitVerdict({ ...f.params, input: { ...input, expectedHeadSha: 'abc' } }),
    ).rejects.toThrow();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('foreign PR is a scoped 404, without head information', async () => {
    const f = fixture();
    await expect(
      f.service.submitVerdict({ ...f.params, organizationId: 'foreign' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(f.db.review.upsert).not.toHaveBeenCalled();
  });
  it.each([Role.DEVELOPER, Role.VIEWER])('denies final verdict for %s', async (role) => {
    const f = fixture();
    await expect(f.service.submitVerdict({ ...f.params, role })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it('denies self-approval but allows the author to request changes', async () => {
    const f = fixture();
    f.pr.authorUserId = 'user';
    await expect(f.service.submitVerdict(f.params)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.service.submitVerdict({
      ...f.params,
      verdict: ReviewVerdict.CHANGES_REQUESTED,
      input: { ...input, verdict: 'CHANGES_REQUESTED' },
    });
    expect(f.db.review.upsert).toHaveBeenCalledOnce();
  });
  it('retains same-head upsert semantics', async () => {
    const f = fixture();
    await f.service.submitVerdict(f.params);
    await f.service.submitVerdict({
      ...f.params,
      verdict: ReviewVerdict.CHANGES_REQUESTED,
      input: { ...input, verdict: 'CHANGES_REQUESTED' },
    });
    const calls = f.db.review.upsert.mock.calls;
    expect(calls.map(([args]) => args.where)).toEqual(
      [0, 1].map(() => ({
        pullRequestId_reviewerId_headSha: {
          pullRequestId: 'pr',
          reviewerId: 'user',
          headSha: head,
        },
      })),
    );
    expect(calls[1][0].update.verdict).toBe('CHANGES_REQUESTED');
  });
  it('propagates critical audit failure without feedback or false success', async () => {
    const f = fixture();
    f.db.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.service.submitVerdict(f.params)).rejects.toThrow('audit unavailable');
    expect(f.db.pullRequest.update).not.toHaveBeenCalled();
  });
  it('feedback failure does not invalidate committed verdict and audit', async () => {
    const f = fixture();
    f.db.pullRequest.update.mockRejectedValueOnce(new Error('feedback unavailable'));
    expect((await f.service.submitVerdict(f.params)).review.headSha).toBe(head);
    expect(f.db.auditLog.create).toHaveBeenCalledOnce();
  });
});
