import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { GithubClient } from './client';
import { verifyExactGitFile, EXACT_GIT_LIMITS } from './exact-git-file';
const revision = 'a'.repeat(40),
  root = 'b'.repeat(40),
  nested = 'c'.repeat(40);
function fixture(bytes = Buffer.from('hello\n'), mode = '100644', type = 'blob') {
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const reader = {
    commit: vi.fn(async () => ({ sha: revision, tree: { sha: root } })),
    tree: vi.fn(async (id: string) => ({
      sha: id,
      truncated: false,
      tree:
        id === root
          ? [{ path: 'src', type: 'tree', mode: '040000', sha: nested }]
          : [{ path: 'file.ts', type, mode, sha: blobSha, size: bytes.length }],
    })),
    blob: vi.fn(async () => ({
      sha: blobSha,
      size: bytes.length,
      encoding: 'base64',
      content: bytes.toString('base64'),
    })),
  };
  return { reader, blobSha };
}
it('walks each exact tree component and verifies regular UTF-8 Git blob identity', async () => {
  const { reader, blobSha } = fixture();
  const result = await verifyExactGitFile(reader, revision, 'src/file.ts');
  expect(result).toMatchObject({
    revision,
    path: 'src/file.ts',
    kind: 'REGULAR_FILE',
    mode: '100644',
    objectSha: blobSha,
    modificationEligible: true,
    content: 'hello\n',
    contentHash: createHash('sha256').update('hello\n').digest('hex'),
  });
  expect(result.components.map((c) => c.kind)).toEqual(['DIRECTORY', 'REGULAR_FILE']);
  expect(reader.tree.mock.calls.map((c) => c[0])).toEqual([root, nested]);
  expect(reader.blob).toHaveBeenCalledOnce();
});
it.each([
  ['100755', 'blob', 'REGULAR_FILE'],
  ['120000', 'blob', 'SYMLINK'],
  ['160000', 'commit', 'SUBMODULE'],
  ['040000', 'tree', 'DIRECTORY'],
  ['100600', 'blob', 'UNSUPPORTED'],
  ['100644', 'commit', 'UNSUPPORTED'],
  ['999999', 'blob', 'UNSUPPORTED'],
])('classifies %s/%s without fetching unsafe content', async (mode, type, kind) => {
  const { reader } = fixture(undefined, mode, type);
  const result = await verifyExactGitFile(reader, revision, 'src/file.ts');
  expect(result.kind).toBe(kind);
  expect(result.modificationEligible).toBe(false);
  expect(reader.blob).not.toHaveBeenCalled();
});
it.each([
  ['120000', 'blob', 'SYMLINK'],
  ['160000', 'commit', 'SUBMODULE'],
  ['100644', 'blob', 'REGULAR_FILE'],
])('does not traverse intermediate %s entries', async (mode, type, kind) => {
  const { reader } = fixture();
  reader.tree.mockResolvedValue({
    sha: root,
    truncated: false,
    tree: [{ path: 'src', mode, type, sha: nested }],
  });
  const result = await verifyExactGitFile(reader, revision, 'src/file.ts');
  expect(result.kind).toBe(kind);
  expect(result.modificationEligible).toBe(false);
  expect(reader.tree).toHaveBeenCalledOnce();
  expect(reader.blob).not.toHaveBeenCalled();
});
it.each([
  '../x',
  'a/../x',
  '%2e%2e/x',
  '/etc/passwd',
  'C:/x',
  '\\\\host\\x',
  '.git/config',
  'a/.GIT/config',
  'a//b',
  'a\\b',
  'CON.txt',
  'a/NUL',
  'a. /b',
  'a/'.repeat(16) + 'x',
])('rejects unsafe/deep path before lookup: %s', async (path) => {
  const { reader } = fixture();
  await expect(verifyExactGitFile(reader, revision, path)).rejects.toThrow();
  expect(reader.commit).not.toHaveBeenCalled();
});
it('rejects branch names before lookup', async () => {
  const { reader } = fixture();
  await expect(verifyExactGitFile(reader, 'main', 'src/file.ts')).rejects.toThrow();
  expect(reader.commit).not.toHaveBeenCalled();
});
it('rejects missing paths and wrong path case', async () => {
  const { reader } = fixture();
  await expect(verifyExactGitFile(reader, revision, 'src/missing')).rejects.toMatchObject({
    kind: 'NOT_FOUND',
  });
  await expect(verifyExactGitFile(reader, revision, 'Src/file.ts')).rejects.toMatchObject({
    kind: 'NOT_FOUND',
  });
});
it('rejects ambiguous case collisions', async () => {
  const { reader } = fixture();
  reader.tree.mockResolvedValue({
    sha: root,
    truncated: false,
    tree: [
      { path: 'src', type: 'tree', mode: '040000', sha: nested },
      { path: 'SRC', type: 'tree', mode: '040000', sha: nested },
    ],
  });
  await expect(verifyExactGitFile(reader, revision, 'src/file.ts')).rejects.toThrow('Ambiguous');
});
it.each(['truncated', 'wrongTree', 'oversizedTree', 'wrongCommit'])(
  'fails closed on incomplete identity: %s',
  async (variant) => {
    const { reader } = fixture();
    if (variant === 'wrongCommit')
      reader.commit.mockResolvedValue({ sha: nested, tree: { sha: root } });
    else
      reader.tree.mockResolvedValue({
        sha: variant === 'wrongTree' ? nested : root,
        truncated: variant === 'truncated',
        tree:
          variant === 'oversizedTree'
            ? Array.from({ length: EXACT_GIT_LIMITS.treeEntries + 1 }, () => ({
                path: 'x',
                type: 'blob',
                mode: '100644',
                sha: nested,
              }))
            : [],
      });
    await expect(verifyExactGitFile(reader, revision, 'src/file.ts')).rejects.toThrow();
    expect(reader.blob).not.toHaveBeenCalled();
  },
);
it.each([Buffer.from([0]), Buffer.from([255]), Buffer.alloc(EXACT_GIT_LIMITS.blobBytes + 1)])(
  'rejects binary/oversized blobs',
  async (bytes) => {
    const { reader } = fixture(bytes);
    await expect(verifyExactGitFile(reader, revision, 'src/file.ts')).rejects.toThrow();
  },
);
it.each(['hash', 'size', 'encoding'])('rejects mismatched blob %s', async (variant) => {
  const { reader } = fixture();
  const original = await reader.blob();
  reader.blob.mockResolvedValue({
    ...original,
    ...(variant === 'hash'
      ? { sha: root }
      : variant === 'size'
        ? { size: 1 }
        : { encoding: 'utf8' }),
  });
  await expect(verifyExactGitFile(reader, revision, 'src/file.ts')).rejects.toThrow();
});
it('metadata-only read never claims text modification eligibility', async () => {
  const { reader } = fixture();
  expect(
    (await verifyExactGitFile(reader, revision, 'src/file.ts', { readContent: false }))
      .modificationEligible,
  ).toBe(false);
  expect(reader.blob).not.toHaveBeenCalled();
});
it('verifies bytes rather than trusting a matching claimed blob SHA', async () => {
  const { reader } = fixture();
  const original = await reader.blob();
  reader.blob.mockResolvedValue({
    ...original,
    content: Buffer.from('other\n').toString('base64'),
  });
  await expect(verifyExactGitFile(reader, revision, 'src/file.ts')).rejects.toThrow(
    'Blob identity',
  );
});
it('rejects absent upstream blob size rather than guessing', async () => {
  const { reader } = fixture();
  const original = await reader.blob();
  reader.blob.mockResolvedValue({ ...original, size: null } as never);
  await expect(verifyExactGitFile(reader, revision, 'src/file.ts')).rejects.toThrow(
    'Invalid or oversized',
  );
});
it('stops after cancellation during a tree read', async () => {
  const { reader } = fixture(),
    abort = new AbortController();
  reader.tree.mockImplementation(async (id) => {
    abort.abort();
    return { sha: id, truncated: false, tree: [] };
  });
  await expect(
    verifyExactGitFile(reader, revision, 'src/file.ts', { signal: abort.signal }),
  ).rejects.toThrow('cancelled');
  expect(reader.tree).toHaveBeenCalledOnce();
  expect(reader.blob).not.toHaveBeenCalled();
});
it('honors cancellation before any lookup', async () => {
  const { reader } = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(
    verifyExactGitFile(reader, revision, 'src/file.ts', { signal: abort.signal }),
  ).rejects.toThrow();
  expect(reader.commit).not.toHaveBeenCalled();
});
it('keeps all wire reads in the authorized repository, without recursive trees or retries', async () => {
  const client = new GithubClient({ accessToken: 'synthetic-only' }),
    octokit = Reflect.get(client, 'octokit'),
    { reader } = fixture();
  const commit = vi
      .spyOn(octokit.git, 'getCommit')
      .mockResolvedValue({ data: await reader.commit() }),
    tree = vi
      .spyOn(octokit.git, 'getTree')
      .mockImplementation(async ({ tree_sha }: { tree_sha: string }) => ({
        data: await reader.tree(tree_sha),
      })),
    blob = vi.spyOn(octokit.git, 'getBlob').mockResolvedValue({ data: await reader.blob() });
  expect(
    (await client.verifyExactFile('safe/repo', 'src/file.ts', revision)).modificationEligible,
  ).toBe(true);
  for (const mock of [commit, tree, blob])
    for (const [args] of mock.mock.calls) {
      expect(args).toMatchObject({ owner: 'safe', repo: 'repo', request: { timeout: 15000 } });
      expect(args).not.toHaveProperty('recursive');
    }
  expect(commit).toHaveBeenCalledOnce();
  expect(tree).toHaveBeenCalledTimes(2);
  expect(blob).toHaveBeenCalledOnce();
});
