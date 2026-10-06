import { describe, expect, it, vi } from 'vitest';
import { ListPullRequestsQuerySchema } from '@codelens/shared';
import { zodQuery } from '../common/zod-validation.pipe';
import { PullRequestsController } from './pull-requests.controller';
import { PullRequestsService } from './pull-requests.service';

function fixture() {
  const row = {
    id: 'pr-a',
    repository: { id: 'repo-a', fullName: 'tenant-a/repo' },
    number: 1,
    title: 'Review me',
    state: 'OPEN',
    authorLogin: 'author',
    authorAvatarUrl: null,
    authorUserId: null,
    headRef: 'feature',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    additions: 26,
    deletions: 5,
    changedFiles: 4,
    commitCount: 1,
    draft: false,
    htmlUrl: 'https://example.invalid/tenant-a/repo/pull/1',
    githubCreatedAt: new Date('2026-01-01T00:00:00Z'),
    githubUpdatedAt: new Date('2026-01-02T00:00:00Z'),
    latestRiskScore: 78,
    latestRiskLevel: 'HIGH',
    reviews: [
      { verdict: 'APPROVED', headSha: 'a'.repeat(40) },
      { verdict: 'APPROVED', headSha: 'b'.repeat(40) },
    ],
    runs: [{ id: 'run', status: 'PARTIAL', stage: 'COMPLETED', finishedAt: null }],
    files: [{ flags: ['TEST'] }],
    _count: { comments: 3 },
  };
  const pullRequest = {
    findMany: vi.fn(async (_query: { where: Record<string, unknown> }) => [row]),
    count: vi.fn(async (_query: { where: Record<string, unknown> }) => 3),
  };
  const service = new PullRequestsService(
    { unscoped: { pullRequest } } as never,
    {} as never,
    {} as never,
  );
  return { row, pullRequest, service, controller: new PullRequestsController(service) };
}

describe('validated pull request listing', () => {
  it('carries validated repository scope through the controller into both database queries', async () => {
    const f = fixture();
    const query = zodQuery(ListPullRequestsQuerySchema).transform({
      repositoryId: 'repo-a',
      page: '2',
      pageSize: '2',
      organizationId: 'tenant-b',
    });
    const result = await f.controller.list('tenant-a', query);
    const find = f.pullRequest.findMany.mock.calls[0]![0];
    expect(find).toMatchObject({
      where: { organizationId: 'tenant-a', repositoryId: 'repo-a' },
      skip: 2,
      take: 2,
      orderBy: { githubUpdatedAt: 'desc' },
      include: { repository: { select: { id: true, fullName: true } } },
    });
    expect(f.pullRequest.count).toHaveBeenCalledWith({ where: find.where });
    expect(result).toMatchObject({ total: 3, page: 2, pageSize: 2, totalPages: 2, hasNext: false });
    expect(f.pullRequest.findMany).toHaveBeenCalledOnce();
    expect(f.pullRequest.count).toHaveBeenCalledOnce();
  });

  it('keeps organization-wide listing and existing response semantics additive', async () => {
    const f = fixture();
    const result = await f.controller.list(
      'tenant-a',
      zodQuery(ListPullRequestsQuerySchema).transform({}),
    );
    expect(f.pullRequest.findMany.mock.calls[0]![0]).toMatchObject({
      where: { organizationId: 'tenant-a' },
      skip: 0,
      take: 25,
    });
    expect(f.pullRequest.findMany.mock.calls[0]![0].where).not.toHaveProperty('repositoryId');
    expect(result.items[0]).toMatchObject({
      repository: { id: 'repo-a', fullName: 'tenant-a/repo' },
      risk: { score: 78, level: 'HIGH', modelVersion: 'latest' },
      latestRun: { id: 'run', status: 'PARTIAL' },
      humanReviewSummary: { approvals: 1, changesRequested: 0, needsDiscussion: 0 },
      unresolvedCommentCount: 3,
      flags: ['TEST'],
      additions: 26,
      deletions: 5,
      changedFiles: 4,
    });
    expect(Object.keys(result.items[0]!.repository).sort()).toEqual(['fullName', 'id']);
    expect(result.items[0]).not.toHaveProperty('headSha');
    expect(result.items[0]).not.toHaveProperty('gate');
  });

  it('rejects an invalid repository identifier before invoking the controller', () => {
    const f = fixture();
    expect(() => zodQuery(ListPullRequestsQuerySchema).transform({ repositoryId: '' })).toThrow();
    expect(f.pullRequest.findMany).not.toHaveBeenCalled();
  });
});
