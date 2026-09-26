import { describe, expect, it, vi } from 'vitest';
import { ReviewVerdict } from '@codelens/database';
import { ReviewSessionsService } from './review-sessions.service';

describe('review training labels', () => {
  it('retains a historical changes-requested label after approval revises the review row', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      unscoped: {
        review: { count: vi.fn().mockResolvedValue(0) },
        auditLog: { findFirst: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
        pullRequest: { update },
      },
    };
    const service = new ReviewSessionsService(
      prisma as never, {} as never, {} as never, {} as never,
      {} as never, {} as never,
    );

    await service['recordTrainingLabels']({
      organizationId: 'org-1',
      pullRequest: { id: 'pr-1', wasRisky: false, firstReviewedAt: new Date(), githubCreatedAt: null },
      verdict: ReviewVerdict.APPROVED,
    });

    expect(prisma.unscoped.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organizationId: 'org-1',
        AND: [
          { metadata: { path: ['pullRequestId'], equals: 'pr-1' } },
          { metadata: { path: ['verdict'], equals: ReviewVerdict.CHANGES_REQUESTED } },
        ],
      }),
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ wasRisky: true }),
    }));
  });
});
