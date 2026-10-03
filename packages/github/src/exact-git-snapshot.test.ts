import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { materializeExactSnapshot, snapshotDigest, SNAPSHOT_LIMITS } from './exact-git-snapshot';
import type { ExactGitReader } from './exact-git-file';
const revision = 'a'.repeat(40),
  root = 'b'.repeat(40),
  nested = 'c'.repeat(40);
function fixture(content = Buffer.from('hello\n')) {
  const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const reader = {
    commit: vi.fn(async () => ({ sha: revision, tree: { sha: root } })),
    tree: vi.fn(async (sha: string) => ({
      sha,
      truncated: false,
      tree:
        sha === root
          ? [{ path: 'src', type: 'tree', mode: '040000', sha: nested }]
          : ['a.ts', 'b.ts'].map((path) => ({
              path,
              type: 'blob',
              mode: '100644',
              sha: blob,
              size: content.length,
            })),
    })),
    blob: vi.fn(async () => ({
      sha: blob,
      encoding: 'base64',
      size: content.length,
      content: content.toString('base64'),
    })),
  };
  return { reader, blob };
}
it('verifies all bytes, sorts manifest, and caches repeated exact objects', async () => {
  const { reader } = fixture();
  const snapshot = await materializeExactSnapshot(reader, 'owner/repo', revision);
  expect(snapshot.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  expect(snapshot.digest).toBe(snapshotDigest(snapshot));
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.files)).toBe(true);
  expect(Object.isFrozen(snapshot.files[0])).toBe(true);
  expect((await materializeExactSnapshot(reader, 'owner/repo', revision)).digest).toBe(
    snapshot.digest,
  );
  expect(reader.blob).toHaveBeenCalledTimes(2); // Once per independent operation.
  expect(reader.commit).toHaveBeenCalledTimes(2);
  expect(reader.tree).toHaveBeenCalledTimes(4);
});
it('cancels a stalled transport even when the reader ignores its signal', async () => {
  const { reader } = fixture();
  reader.commit.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const pending = materializeExactSnapshot(reader, 'owner/repo', revision, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});
it('supports an empty exact tree without fabricating files', async () => {
  const { reader } = fixture();
  reader.tree.mockResolvedValue({ sha: root, truncated: false, tree: [] });
  expect((await materializeExactSnapshot(reader, 'owner/repo', revision)).files).toEqual([]);
});
it.each(['120000', '160000', '100755', '100600'])(
  'rejects the whole snapshot for mode %s',
  async (mode) => {
    const { reader, blob } = fixture();
    reader.tree.mockResolvedValue({
      sha: root,
      truncated: false,
      tree: [{ path: 'bad', mode, type: mode === '160000' ? 'commit' : 'blob', sha: blob }],
    });
    await expect(materializeExactSnapshot(reader, 'owner/repo', revision)).rejects.toThrow(
      'Unsupported',
    );
    expect(reader.blob).not.toHaveBeenCalled();
  },
);
it.each(['../x', '%2e%2e', '/x', 'C:x', '\\host', '.git', 'NUL.txt', 'x.', 'x '])(
  'rejects path %s',
  async (path) => {
    const { reader, blob } = fixture();
    reader.tree.mockResolvedValue({
      sha: root,
      truncated: false,
      tree: [{ path, type: 'blob', mode: '100644', sha: blob }],
    });
    await expect(materializeExactSnapshot(reader, 'owner/repo', revision)).rejects.toThrow();
  },
);
it('rejects case collisions including empty directories', async () => {
  const { reader } = fixture();
  reader.tree.mockImplementation(async (sha) => ({
    sha,
    truncated: false,
    tree:
      sha === root
        ? ['src', 'SRC'].map((path) => ({ path, type: 'tree', mode: '040000', sha: nested }))
        : [],
  }));
  await expect(materializeExactSnapshot(reader, 'owner/repo', revision)).rejects.toThrow(
    'case-colliding',
  );
});
it.each([Buffer.from([0]), Buffer.from([255]), Buffer.alloc(1024 * 1024 + 1)])(
  'rejects binary and oversized originals',
  async (bytes) => {
    await expect(
      materializeExactSnapshot(fixture(bytes).reader, 'owner/repo', revision),
    ).rejects.toThrow();
  },
);
it('rejects truncated trees and wrong blob identity', async () => {
  const { reader } = fixture();
  reader.tree.mockResolvedValue({ sha: root, truncated: true, tree: [] });
  await expect(materializeExactSnapshot(reader, 'owner/repo', revision)).rejects.toThrow(
    'Incomplete',
  );
  const other = fixture();
  other.reader.blob.mockResolvedValue({
    sha: other.blob,
    encoding: 'base64',
    size: 6,
    content: Buffer.from('other\n').toString('base64'),
  });
  await expect(materializeExactSnapshot(other.reader, 'owner/repo', revision)).rejects.toThrow(
    'identity',
  );
});
it.each([1001, 2001])('rejects file/entry bounds %s', async (count) => {
  const { reader, blob } = fixture();
  reader.tree.mockResolvedValue({
    sha: root,
    truncated: false,
    tree: Array.from({ length: count }, (_, n) => ({
      path: `f${n}`,
      type: 'blob',
      mode: '100644',
      sha: blob,
    })),
  });
  await expect(materializeExactSnapshot(reader, 'owner/repo', revision)).rejects.toThrow('limit');
});
it('rejects depth >16 and aggregate source >16MiB', async () => {
  const deep: ExactGitReader = {
    commit: async () => ({ sha: revision, tree: { sha: root } }),
    tree: async (sha) => ({
      sha,
      tree: [
        {
          path: 'd',
          type: 'tree',
          mode: '040000',
          sha: (Number.parseInt(sha.slice(-4), 16) + 1).toString(16).padStart(40, '0'),
        },
      ],
    }),
    blob: async () => {
      throw new Error('unreachable');
    },
  };
  await expect(materializeExactSnapshot(deep, 'owner/repo', revision)).rejects.toThrow('path');
  const { reader, blob } = fixture(Buffer.alloc(SNAPSHOT_LIMITS.blobBytes, 97));
  reader.tree.mockResolvedValue({
    sha: root,
    truncated: false,
    tree: Array.from({ length: 17 }, (_, n) => ({
      path: `f${n}`,
      type: 'blob',
      mode: '100644',
      sha: blob,
      size: SNAPSHOT_LIMITS.blobBytes,
    })),
  });
  await expect(materializeExactSnapshot(reader, 'owner/repo', revision)).rejects.toThrow(
    'source byte',
  );
});
