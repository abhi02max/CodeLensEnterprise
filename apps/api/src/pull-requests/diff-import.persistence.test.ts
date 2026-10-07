import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@codelens/database';
import { PullRequestsService } from './pull-requests.service';
import { RepositoriesService } from '../repositories/repositories.service';

// Never fall back to DATABASE_URL or any existing demo database.
const url = process.env.PR_DIFF_TEST_DATABASE_URL;
describe.skipIf(!url)('revision publication on isolated PostgreSQL', () => {
  let db: PrismaClient;
  const prefix = `diff-${randomUUID()}`;
  const org = `${prefix}-org`,
    foreign = `${prefix}-foreign`,
    repo = `${prefix}-repo`;
  const base = 'a'.repeat(40),
    old = 'b'.repeat(40),
    newer = 'c'.repeat(40);
  let number = 0;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
      parsed.pathname !== '/codelens_pr_diff_contract_test'
    )
      throw new Error('Use only the dedicated local codelens_pr_diff_contract_test database');
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$connect();
    if (await db.organization.count())
      throw new Error('Dedicated proof database must initially be empty');
    await db.organization.createMany({
      data: [org, foreign].map((id) => ({ id, slug: id, name: id })),
    });
    await db.repository.create({
      data: {
        id: repo,
        organizationId: org,
        githubId: 1,
        fullName: 'synthetic/repo',
        owner: 'synthetic',
        name: 'repo',
      },
    });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.organization.deleteMany({ where: { id: { in: [org, foreign] } } });
    } finally {
      await db.$disconnect();
    }
  });
  const metadata = (n: number, headSha: string) => ({
    number: n,
    title: 'Synthetic diff',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    htmlUrl: 'https://example.invalid/pull/1',
    authorLogin: 'synthetic',
    authorAvatarUrl: null,
    headRef: 'feature',
    headSha,
    baseRef: 'main',
    baseSha: base,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commitCount: 0,
    mergedAt: null,
    closedAt: null,
    labels: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  });
  const file = (value: string) => ({
    filename: 'src/a.ts',
    previousFilename: null,
    status: 'MODIFIED',
    additions: 1,
    deletions: 1,
    changes: 2,
    language: 'typescript',
    flags: [],
    patch: `@@ -1 +1 @@\n-old\n+${value}`,
    patchTruncated: false,
    binary: false,
    touchedLines: [1],
  });
  const service = (client: object, clientDb = db) =>
    new PullRequestsService(
      { unscoped: clientDb } as never,
      { forRepository: async () => ({ client }) } as never,
      { record: async () => undefined } as never,
    );
  const client = (n: number, headSha: string, value = 'new') => ({
    getPullRequest: vi.fn(async () => metadata(n, headSha)),
    getPullRequestFiles: vi.fn(async () => [file(value)]),
    getPullRequestCommits: vi.fn(async () => []),
    verifyPullRequestFiles: vi.fn(async () => ({ mergeBaseSha: base })),
  });
  const run = (s: PullRequestsService, n: number) =>
    s.importFromGithub(org, {
      repositoryId: repo,
      number: n,
      userId: null,
    });
  async function published(n: number) {
    const result = await run(service(client(n, old)), n);
    return {
      result,
      snapshot: await db.pullRequest.findUniqueOrThrow({
        where: { id: result.id },
        include: { files: true },
      }),
    };
  }

  it('publishes coherent detail/files and denies a foreign tenant', async () => {
    const n = ++number,
      s = service(client(n, old));
    const detail = await run(s, n);
    const files = await s.getDiff(org, detail.id);
    expect(detail.diffRevision).toMatchObject({
      provenance: 'VERIFIED',
      headSha: old,
      baseSha: base,
    });
    expect(files.diffRevision).toEqual(detail.diffRevision);
    expect(files.files[0]).toMatchObject({ patchAvailability: 'AVAILABLE', binary: false });
    const legacyArray = await s.getFiles(org, detail.id);
    expect(Array.isArray(legacyArray)).toBe(true);
    expect(legacyArray[0]).toMatchObject({
      diffRevision: files.diffRevision,
      touchedLines: [1],
      pullRequestId: detail.id,
    });
    await expect(s.getDiff(foreign, detail.id)).rejects.toThrow('not found');
    await expect(s.findOne(foreign, detail.id)).rejects.toThrow('not found');
  });

  it('leaves a prior coherent publication unchanged on partially acquired remote data failure', async () => {
    const n = ++number,
      before = await published(n),
      c = client(n, newer);
    c.getPullRequestCommits.mockRejectedValue(new Error('synthetic acquisition failure'));
    await expect(run(service(c), n)).rejects.toThrow('acquisition');
    expect(
      await db.pullRequest.findUnique({
        where: { id: before.result.id },
        include: { files: true },
      }),
    ).toEqual(before.snapshot);
  });

  it('detects observed head movement without publication or automatic unbounded retry', async () => {
    const n = ++number,
      before = await published(n),
      c = client(n, newer);
    c.getPullRequest
      .mockResolvedValueOnce(metadata(n, old))
      .mockResolvedValueOnce(metadata(n, newer));
    await expect(run(service(c), n)).rejects.toThrow('moved');
    expect(c.getPullRequest).toHaveBeenCalledTimes(2);
    expect(
      await db.pullRequest.findUnique({
        where: { id: before.result.id },
        include: { files: true },
      }),
    ).toEqual(before.snapshot);
  });

  it('deterministically rejects older import A after newer B publishes', async () => {
    const n = ++number;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const a = client(n, old, 'A');
    a.getPullRequestFiles.mockImplementation(async () => {
      entered();
      await gate;
      return [file('A')];
    });
    const pending = run(service(a), n);
    // Attach rejection handling before deliberately unblocking publication.
    const rejected = expect(pending).rejects.toThrow('superseded');
    await acquired;
    const b = await run(service(client(n, newer, 'B')), n);
    release();
    await rejected;
    const readback = await service({}).getDiff(org, b.id);
    expect(readback.headSha).toBe(newer);
    expect(readback.diffRevision.headSha).toBe(newer);
    expect(readback.files.map((f) => f.patch)).toEqual([file('B').patch]);
  });

  it('rolls back metadata and deleted files when a real DB write fails', async () => {
    const n = ++number,
      before = await published(n),
      c = client(n, newer);
    // Rejected enum input rolls back the real transaction after its PR upsert.
    c.getPullRequestFiles.mockResolvedValue([{ ...file('new'), status: 'INVALID_ENUM' }]);
    await expect(run(service(c), n)).rejects.toThrow();
    expect(
      await db.pullRequest.findUnique({
        where: { id: before.result.id },
        include: { files: true },
      }),
    ).toEqual(before.snapshot);
  });

  it('readers see the old coherent snapshot during publication, then the new one', async () => {
    const n = ++number,
      before = await published(n);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staged = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property);
        return (callback: (tx: unknown) => Promise<unknown>) =>
          target.$transaction(async (tx) =>
            callback(
              new Proxy(tx, {
                get(inner, key) {
                  if (key !== 'pullRequestFile') return Reflect.get(inner, key);
                  return new Proxy(inner.pullRequestFile, {
                    get(files, method) {
                      if (method !== 'createMany') return Reflect.get(files, method);
                      return async (args: Parameters<typeof files.createMany>[0]) => {
                        reached();
                        await gate;
                        return files.createMany(args);
                      };
                    },
                  });
                },
              }),
            ),
          );
      },
    });
    const pending = run(service(client(n, newer, 'B'), wrapped), n);
    await staged;
    try {
      const during = await service({}).getDiff(org, before.result.id);
      expect(during.headSha).toBe(old);
      expect(during.diffRevision.headSha).toBe(old);
      expect(during.files[0]?.patch).toBe(file('new').patch);
    } finally {
      release();
    }
    const after = await pending;
    const readback = await service({}).getDiff(org, after.id);
    expect(readback.headSha).toBe(newer);
    expect(readback.diffRevision.headSha).toBe(newer);
    expect(readback.files[0]?.patch).toBe(file('B').patch);
  });

  it('does not bless legacy rows and upgrades them only through verified import', async () => {
    const n = ++number,
      data = metadata(n, old);
    const legacy = await db.pullRequest.create({
      data: {
        organizationId: org,
        repositoryId: repo,
        number: n,
        title: data.title,
        htmlUrl: data.htmlUrl,
        authorLogin: data.authorLogin,
        headRef: data.headRef,
        headSha: old,
        baseRef: 'main',
        baseSha: base,
        githubCreatedAt: new Date(data.createdAt),
        githubUpdatedAt: new Date(data.updatedAt),
        files: { create: { ...file('legacy'), status: 'MODIFIED' } },
      },
    });
    expect((await service({}).getDiff(org, legacy.id)).diffRevision.provenance).toBe('UNVERIFIED');
    await run(service(client(n, old)), n);
    expect((await service({}).getDiff(org, legacy.id)).diffRevision.provenance).toBe('VERIFIED');
  });

  it('metadata-only repository sync invalidates old provenance and fences acquired imports', async () => {
    const n = ++number,
      before = await published(n);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pendingClient = client(n, old);
    pendingClient.getPullRequestFiles.mockImplementation(async () => {
      entered();
      await gate;
      return [file('new')];
    });
    const pending = run(service(pendingClient), n);
    const rejected = expect(pending).rejects.toThrow('superseded');
    await acquired;
    const syncClient = {
      getRepositoryMetadata: async () => ({
        fullName: 'synthetic/repo',
        name: 'repo',
        owner: 'synthetic',
        description: null,
        private: false,
        defaultBranch: 'main',
        primaryLanguage: 'typescript',
        htmlUrl: 'https://example.invalid/repo',
      }),
      listPullRequests: async () => [metadata(n, newer)],
    };
    const repositories = new RepositoriesService(
      { unscoped: db } as never,
      { forRepository: async () => ({ client: syncClient }) } as never,
      {} as never,
      { record: async () => undefined } as never,
      {} as never,
    );
    try {
      await repositories.sync(org, repo, null, {});
    } finally {
      release();
    }
    await rejected;
    const readback = await service({}).getDiff(org, before.result.id);
    expect(readback.headSha).toBe(newer);
    expect(readback.diffRevision.provenance).toBe('UNVERIFIED');
    expect(readback.diffRevision.headSha).toBeNull();
    expect(readback.files[0]?.patch).toBe(file('new').patch);
  });
});
