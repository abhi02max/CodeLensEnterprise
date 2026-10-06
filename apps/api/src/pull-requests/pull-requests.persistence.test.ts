import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@codelens/database';
import { ListPullRequestsQuerySchema } from '@codelens/shared';
import { zodQuery } from '../common/zod-validation.pipe';
import { PullRequestsController } from './pull-requests.controller';
import { PullRequestsService } from './pull-requests.service';

// Opt-in only: never use the ordinary DATABASE_URL or existing demo persistence.
const databaseUrl = process.env.PR_LIST_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('pull request listing on isolated PostgreSQL', () => {
  let db: PrismaClient;
  let controller: PullRequestsController;
  const prefix = `pr-list-${randomUUID()}`;
  const orgA = `${prefix}-a`;
  const orgB = `${prefix}-b`;
  const repoA = `${prefix}-ra`;
  const repoA2 = `${prefix}-ra2`;
  const repoB = `${prefix}-rb`;
  const queries: string[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/codelens_pr_list_contract_test'
    )
      throw new Error('Use only the dedicated local codelens_pr_list_contract_test database');
    const client = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      log: [{ emit: 'event', level: 'query' }],
    });
    client.$on('query', (event) => queries.push(event.query));
    db = client;
    await db.$connect();
    if ((await db.organization.count()) !== 0)
      throw new Error('Persistence proof requires an empty dedicated test database');
    await db.organization.createMany({
      data: [
        { id: orgA, name: 'Contract tenant A', slug: orgA },
        { id: orgB, name: 'Contract tenant B', slug: orgB },
      ],
    });
    await db.repository.createMany({
      data: [
        {
          id: repoA,
          organizationId: orgA,
          githubId: 1,
          fullName: 'contract-a/one',
          name: 'one',
          owner: 'contract-a',
        },
        {
          id: repoA2,
          organizationId: orgA,
          githubId: 2,
          fullName: 'contract-a/two',
          name: 'two',
          owner: 'contract-a',
        },
        {
          id: repoB,
          organizationId: orgB,
          githubId: 3,
          fullName: 'contract-b/private',
          name: 'private',
          owner: 'contract-b',
          private: true,
        },
      ],
    });
    await db.pullRequest.createMany({
      data: [repoA, repoA, repoA, repoA2, repoB].map((repositoryId, index) => ({
        id: `${prefix}-p${index}`,
        organizationId: repositoryId === repoB ? orgB : orgA,
        repositoryId,
        number: index + 1,
        title: `Contract PR ${index + 1}`,
        htmlUrl: `https://example.invalid/pull/${index + 1}`,
        authorLogin: 'contract-author',
        headRef: 'feature',
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        baseSha: 'b'.repeat(40),
        githubCreatedAt: new Date('2026-01-01T00:00:00Z'),
        githubUpdatedAt: new Date(`2026-01-0${index + 1}T00:00:00Z`),
      })),
    });
    controller = new PullRequestsController(
      new PullRequestsService({ unscoped: db } as never, {} as never, {} as never),
    );
  });

  afterAll(async () => {
    if (!db) return;
    try {
      // Delete only this test's two tenant fixtures, never a whole database/table.
      await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    } finally {
      await db.$disconnect();
    }
  });

  const list = (input: Record<string, unknown> = {}, organizationId = orgA) =>
    controller.list(organizationId, zodQuery(ListPullRequestsQuerySchema).transform(input));

  it('filters same-tenant repository before pagination and uses its filtered total', async () => {
    const first = await list({ repositoryId: repoA, pageSize: 2 });
    const second = await list({ repositoryId: repoA, pageSize: 2, page: 2 });
    expect(first.items.map((pr) => pr.number)).toEqual([3, 2]);
    expect(second.items.map((pr) => pr.number)).toEqual([1]);
    expect(first).toMatchObject({
      total: 3,
      totalPages: 2,
      page: 1,
      hasNext: true,
      hasPrevious: false,
    });
    expect(second).toMatchObject({
      total: 3,
      totalPages: 2,
      page: 2,
      hasNext: false,
      hasPrevious: true,
    });
    expect([...first.items, ...second.items].every((pr) => pr.repository.id === repoA)).toBe(true);
  });

  it('foreign and nonexistent repositories have the same empty non-disclosing response', async () => {
    const foreign = await list({ repositoryId: repoB, organizationId: orgB });
    expect(foreign).toEqual(await list({ repositoryId: 'missing-repository' }));
    expect(foreign).toMatchObject({ items: [], total: 0, totalPages: 1 });
    expect(JSON.stringify(foreign)).not.toContain('contract-b');
    expect(JSON.stringify(foreign)).not.toContain(repoB);
    expect((await list({ repositoryId: repoB }, orgB)).items).toHaveLength(1);
  });

  it('organization-wide pagination still excludes every foreign PR and repository', async () => {
    const first = await list({ pageSize: 2 });
    const second = await list({ pageSize: 2, page: 2 });
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect(first.items.map((pr) => pr.number)).toEqual([4, 3]);
    expect(second.items.map((pr) => pr.number)).toEqual([2, 1]);
    expect([...first.items, ...second.items].map((pr) => pr.repository.id)).not.toContain(repoB);
  });

  it('returns only id/fullName relationship fields while preserving detail compatibility', async () => {
    const result = await list({ repositoryId: repoA });
    for (const item of result.items) {
      expect(item.repository).toEqual({ id: repoA, fullName: 'contract-a/one' });
      expect(Object.keys(item.repository).sort()).toEqual(['fullName', 'id']);
      expect(item).toMatchObject({ risk: null, latestRun: null, unresolvedCommentCount: 0 });
    }
    const service = new PullRequestsService({ unscoped: db } as never, {} as never, {} as never);
    const detail = await service.findOne(orgA, result.items[0]!.id);
    expect(detail.repository).toEqual({
      id: repoA,
      fullName: 'contract-a/one',
      defaultBranch: 'main',
    });
  });

  it('combines existing filters/order with repository scope in the database', async () => {
    const result = await list({
      repositoryId: repoA,
      search: 'PR 2',
      sortOrder: 'asc',
      state: 'OPEN',
    });
    expect(result.total).toBe(1);
    expect(result.items.map((pr) => pr.number)).toEqual([2]);
  });

  it('batches repository identity instead of querying once per list row', async () => {
    queries.length = 0;
    await list({ pageSize: 1 });
    const oneRowQueries = queries.length;
    const oneRowRepositoryReads = queries.filter((sql) =>
      sql.includes('FROM "public"."Repository"'),
    ).length;
    queries.length = 0;
    await list({ pageSize: 50 });
    expect(queries.length).toBe(oneRowQueries);
    expect(queries.filter((sql) => sql.includes('FROM "public"."Repository"'))).toHaveLength(
      oneRowRepositoryReads,
    );
    expect(oneRowRepositoryReads).toBe(1);
  });
});
