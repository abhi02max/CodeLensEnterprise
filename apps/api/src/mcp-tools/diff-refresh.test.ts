import { expect, it, vi } from 'vitest';
import { ToolsFactory } from './tools.factory';
import { GetPrDiffOutput } from './tool-io.schemas';
const old = 'a'.repeat(40),
  head = 'b'.repeat(40),
  base = 'c'.repeat(40);

it('refresh reloads metadata together with files and exposes unverified history truthfully', async () => {
  const row = {
    id: 'pr',
    organizationId: 'org',
    repositoryId: 'repo',
    repository: { id: 'repo', fullName: 'synthetic/repo' },
    number: 1,
    title: 'Synthetic',
    body: null,
    authorLogin: 'synthetic',
    headSha: old,
    baseSha: base,
    headRef: 'feature',
    baseRef: 'main',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: [],
    commits: [],
    diffBaseSha: null,
    diffHeadSha: null,
    diffMergeBaseSha: null,
    diffVerifiedAt: null,
  };
  const refreshed = {
    ...row,
    headSha: head,
    diffHeadSha: head,
    diffBaseSha: base,
    diffMergeBaseSha: base,
    diffVerifiedAt: new Date(),
    files: [
      {
        filename: 'src/a.ts',
        status: 'MODIFIED',
        language: 'typescript',
        flags: [],
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
        patchTruncated: false,
        binary: false,
        touchedLines: [1],
      },
    ],
  };
  const prisma = {
    pullRequest: {
      findFirst: vi.fn(async () => row),
      findFirstOrThrow: vi.fn(async () => refreshed),
    },
  };
  const transaction = vi.fn(async (callback: (db: typeof prisma) => Promise<unknown>) =>
    callback(prisma),
  );
  const imports = { importFromGithub: vi.fn(async () => undefined) };
  const factory = new ToolsFactory(
    { unscoped: { ...prisma, $transaction: transaction } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    imports as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const tool = factory.build()[0]!;
  const result = await tool.execute(
    { pullRequestId: 'pr', refresh: true } as never,
    { organizationId: 'org', userId: null, reviewRunId: null, logger: { info: vi.fn() } } as never,
  );
  const output = GetPrDiffOutput.parse(result.output);
  expect(output.headSha).toBe(head);
  expect(output.diffRevision).toMatchObject({ provenance: 'VERIFIED', headSha: head });
  expect(output.files[0]?.patch).toContain('+new');
  expect(imports.importFromGithub).toHaveBeenCalledOnce();
  expect(transaction).toHaveBeenCalledTimes(2);
  expect(prisma.pullRequest.findFirstOrThrow).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'pr', organizationId: 'org' },
    }),
  );
});
