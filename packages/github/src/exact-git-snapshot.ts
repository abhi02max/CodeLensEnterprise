import { createHash } from 'node:crypto';
import { GithubError } from './errors';
import { verifyExactGitFile, validateExactGitPath, type ExactGitReader } from './exact-git-file';

export const SNAPSHOT_LIMITS = Object.freeze({
  files: 1000,
  entries: 2000,
  depth: 16,
  blobBytes: 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
  deadlineMs: 150000,
});
export interface ExactSnapshotFile {
  path: string;
  blobSha: string;
  content: string;
  contentHash: string;
  byteLength: number;
}
export interface ExactSnapshot {
  version: 1;
  repository: string;
  revision: string;
  files: ExactSnapshotFile[];
  digest: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never {
  throw new GithubError('VALIDATION_FAILED', message, 400);
}

// Contents are represented by verified hashes in the canonical manifest, never by logs.
export function snapshotDigest(snapshot: Omit<ExactSnapshot, 'digest'>): string {
  return hash(
    JSON.stringify({
      version: snapshot.version,
      repository: snapshot.repository,
      revision: snapshot.revision,
      files: snapshot.files.map(({ path, blobSha, contentHash, byteLength }) => ({
        path,
        blobSha,
        contentHash,
        byteLength,
      })),
    }),
  );
}

/** Complete, bounded nonrecursive tree walk. No checkout, archive, or filesystem access. */
export async function materializeExactSnapshot(
  reader: ExactGitReader,
  repository: string,
  revision: string,
  parentSignal?: AbortSignal,
): Promise<ExactSnapshot> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 256)
    fail('Repository identity required');
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('Exact commit SHA required');
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(SNAPSHOT_LIMITS.deadlineMs)])
    : AbortSignal.timeout(SNAPSHOT_LIMITS.deadlineMs);
  const check = () => {
    if (signal.aborted) fail('Snapshot cancelled or timed out');
  };
  // Cache only within this exact operation, including repeated blobs/subtrees.
  function cache<T>(read: (sha: string, signal: AbortSignal) => Promise<T>) {
    const values = new Map<string, Promise<T>>();
    return (sha: string, readSignal: AbortSignal) => {
      check();
      let value = values.get(sha);
      if (!value) {
        if (readSignal.aborted) fail('Snapshot cancelled or timed out');
        const pending = read(sha, readSignal);
        value = new Promise<T>((resolve, reject) => {
          const abort = () => {
            readSignal.removeEventListener('abort', abort);
            reject(new GithubError('VALIDATION_FAILED', 'Snapshot cancelled or timed out', 400));
          };
          readSignal.addEventListener('abort', abort, { once: true });
          pending.then(
            (result) => {
              readSignal.removeEventListener('abort', abort);
              resolve(result);
            },
            (error) => {
              readSignal.removeEventListener('abort', abort);
              reject(error);
            },
          );
          if (readSignal.aborted) abort();
        });
        values.set(sha, value);
      }
      return value;
    };
  }
  const cached: ExactGitReader = {
    commit: cache(reader.commit.bind(reader)),
    tree: cache(reader.tree.bind(reader)),
    blob: cache(reader.blob.bind(reader)),
  };
  const commit = await cached.commit(revision, signal);
  check();
  if (commit.sha !== revision || !/^[a-f0-9]{40}$/.test(commit.tree?.sha))
    fail('Commit identity mismatch');
  let entries = 0,
    bytes = 0;
  const files: ExactSnapshotFile[] = [];
  const paths = new Set<string>();
  async function walk(treeSha: string, prefix: string, ancestors: Set<string>): Promise<void> {
    check();
    if (ancestors.has(treeSha)) fail('Cyclic Git tree');
    const tree = await cached.tree(treeSha, signal);
    check();
    if (tree.sha !== treeSha || tree.truncated || !Array.isArray(tree.tree))
      fail('Incomplete or mismatched Git tree');
    entries += tree.tree.length;
    if (entries > SNAPSHOT_LIMITS.entries) fail('Snapshot tree entry limit exceeded');
    const next = new Set(ancestors).add(treeSha);
    for (const entry of tree.tree) {
      if (typeof entry.path !== 'string' || entry.path.includes('/'))
        fail('Invalid tree component');
      const path = prefix + entry.path;
      validateExactGitPath(path);
      if (!/^[a-f0-9]{40}$/.test(entry.sha ?? '')) fail('Invalid Git object identity');
      const folded = path.toLowerCase();
      if (paths.has(folded)) fail('Duplicate or case-colliding snapshot path');
      paths.add(folded);
      if (entry.type === 'tree' && entry.mode === '040000') {
        await walk(entry.sha!, path + '/', next);
      } else {
        if (entry.type !== 'blob' || entry.mode !== '100644') fail('Unsupported snapshot object');
        if (files.length >= SNAPSHOT_LIMITS.files) fail('Snapshot file limit exceeded');
        const source = await verifyExactGitFile(cached, revision, path, { signal });
        check();
        if (!source.modificationEligible || source.content === null || source.contentHash === null)
          fail('Unsupported snapshot source');
        const byteLength = Buffer.byteLength(source.content);
        bytes += byteLength;
        if (bytes > SNAPSHOT_LIMITS.sourceBytes) fail('Snapshot source byte limit exceeded');
        files.push({
          path,
          blobSha: source.objectSha,
          content: source.content,
          contentHash: source.contentHash,
          byteLength,
        });
      }
    }
  }
  await walk(commit.tree.sha, '', new Set());
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  files.forEach(Object.freeze);
  Object.freeze(files);
  const snapshot = { version: 1 as const, repository, revision, files };
  return Object.freeze({ ...snapshot, digest: snapshotDigest(snapshot) });
}
