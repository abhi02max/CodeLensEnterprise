import { describe, expect, it } from 'vitest';
import { ListPullRequestsQuerySchema } from './repository';

describe('pull request repository scope contract', () => {
  it('accepts and preserves an optional repository identifier', () => {
    expect(ListPullRequestsQuerySchema.parse({ repositoryId: 'repo-a' }).repositoryId).toBe(
      'repo-a',
    );
    expect(
      ListPullRequestsQuerySchema.parse({ repositoryId: 'x'.repeat(64) }).repositoryId,
    ).toHaveLength(64);
  });

  it.each(['', 'x'.repeat(65), null, 42, [], {}])(
    'rejects invalid identifier %j',
    (repositoryId) => {
      expect(ListPullRequestsQuerySchema.safeParse({ repositoryId }).success).toBe(false);
    },
  );

  it('preserves organization-wide defaults when repository scope is omitted', () => {
    expect(ListPullRequestsQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 25,
      analyzedOnly: false,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
  });

  it('preserves existing filters and pagination, but not client organization authority', () => {
    const parsed = ListPullRequestsQuerySchema.parse({
      repositoryId: 'repo-a',
      organizationId: 'foreign-org',
      page: '2',
      pageSize: '2',
      state: 'OPEN',
      authorLogin: 'reviewer',
      riskLevel: 'HIGH',
      search: '  refund  ',
      sortBy: 'riskScore',
      sortOrder: 'asc',
    });
    expect(parsed).toEqual({
      repositoryId: 'repo-a',
      page: 2,
      pageSize: 2,
      state: 'OPEN',
      authorLogin: 'reviewer',
      riskLevel: 'HIGH',
      search: 'refund',
      sortBy: 'riskScore',
      sortOrder: 'asc',
      analyzedOnly: false,
    });
    expect(parsed).not.toHaveProperty('organizationId');
  });
});
