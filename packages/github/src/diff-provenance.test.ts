import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubClient } from './client';
import { parseFileDiff } from './diff-parser';

const base = 'a'.repeat(40),
  head = 'b'.repeat(40),
  merge = 'c'.repeat(40);
const raw = {
  filename: 'src/a.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -1 +1 @@\n-old\n+new',
};
function fixture() {
  const client = new GithubClient({ accessToken: 'synthetic-only' });
  const request = vi.spyOn(
    client as unknown as {
      request: (label: string, fn: unknown) => Promise<unknown>;
    },
    'request',
  );
  request.mockImplementation(async (label) =>
    label === 'listFiles'
      ? { data: [raw] }
      : { data: { base_commit: { sha: base }, merge_base_commit: { sha: merge }, files: [raw] } },
  );
  return { client, request };
}
afterEach(() => vi.restoreAllMocks());
describe('immutable comparison verification', () => {
  it('verifies the actual payload, not merely before/after metadata', async () => {
    const { client } = fixture();
    const files = await client.getPullRequestFiles('fixture/repo', 1);
    expect(await client.verifyPullRequestFiles('fixture/repo', base, head, files)).toEqual({
      mergeBaseSha: merge,
    });
    await expect(
      client.verifyPullRequestFiles('fixture/repo', base, head, [
        { ...files[0]!, patch: '@@ -1 +1 @@\n-old\n+other' },
      ]),
    ).rejects.toThrow('exact comparison');
  });
  it('rejects wrong base identity, duplicate paths and incomplete files', async () => {
    const { client, request } = fixture();
    const files = await client.getPullRequestFiles('fixture/repo', 1);
    await expect(client.verifyPullRequestFiles('fixture/repo', base, head, [])).rejects.toThrow();
    await expect(
      client.verifyPullRequestFiles('fixture/repo', base, head, [files[0]!, files[0]!]),
    ).rejects.toThrow();
    request.mockResolvedValue({
      data: { base_commit: { sha: head }, merge_base_commit: { sha: merge }, files: [raw] },
    });
    await expect(client.verifyPullRequestFiles('fixture/repo', base, head, files)).rejects.toThrow(
      'revision mismatch',
    );
  });
  it('never equates remote omission with binary', async () => {
    expect(parseFileDiff({ ...raw, patch: undefined }).binary).toBe(false);
    const { client, request } = fixture();
    request.mockResolvedValue({ data: [{ ...raw, patch: undefined }] });
    expect((await client.getPullRequestFiles('fixture/repo', 1))[0]).toMatchObject({
      patch: null,
      binary: false,
    });
  });
  it('propagates a failed later page rather than returning acquired files', async () => {
    const { client, request } = fixture();
    request.mockResolvedValueOnce({
      data: Array.from({ length: 100 }, (_, i) => ({ ...raw, filename: `src/${i}.ts` })),
    });
    request.mockRejectedValueOnce(new Error('synthetic later-page failure'));
    await expect(client.getPullRequestFiles('fixture/repo', 1)).rejects.toThrow('later-page');
  });
  it('rejects mutable branch names rather than calling them exact revisions', async () => {
    const { client, request } = fixture();
    await expect(client.verifyPullRequestFiles('fixture/repo', 'main', head, [])).rejects.toThrow(
      'Exact',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('verifies commit membership and rejects a mismatched acquired commit', async () => {
    const { client, request } = fixture();
    const files = await client.getPullRequestFiles('fixture/repo', 1);
    request.mockResolvedValue({
      data: {
        base_commit: { sha: base },
        merge_base_commit: { sha: merge },
        files: [raw],
        commits: [{ sha: head }],
        total_commits: 1,
      },
    });
    const commit = {
      sha: head,
      shortSha: head.slice(0, 7),
      message: 'Synthetic',
      authorName: 'Synthetic',
      authorLogin: null,
      authoredAt: '2026-01-01T00:00:00Z',
      additions: null,
      deletions: null,
    };
    await expect(
      client.verifyPullRequestFiles('fixture/repo', base, head, files, [commit]),
    ).resolves.toEqual({ mergeBaseSha: merge });
    await expect(
      client.verifyPullRequestFiles('fixture/repo', base, head, files, [{ ...commit, sha: base }]),
    ).rejects.toThrow('commits');
  });

  it('bounds paginated commit acquisition at the intended 250 commits', async () => {
    const { client, request } = fixture();
    request.mockImplementation(async () => ({
      data: Array.from({ length: 100 }, (_, i) => ({
        sha: `synthetic-${request.mock.calls.length}-${i}`,
        commit: { message: 'Synthetic', author: null },
        author: null,
      })),
    }));
    expect(await client.getPullRequestCommits('fixture/repo', 1)).toHaveLength(250);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
