import { createHash } from 'node:crypto';
import { RepositoryPathSchema } from '@codelens/shared';
import { GithubError } from './errors';

export const EXACT_GIT_LIMITS = Object.freeze({
  depth: 16,
  blobBytes: 1024 * 1024,
  deadlineMs: 15000,
  treeEntries: 10000,
});
export type GitEntryKind = 'REGULAR_FILE' | 'DIRECTORY' | 'SYMLINK' | 'SUBMODULE' | 'UNSUPPORTED';
interface Entry {
  path?: string;
  type?: string;
  mode?: string;
  sha?: string;
  size?: number;
}
export interface ExactGitFile {
  revision: string;
  path: string;
  kind: GitEntryKind;
  mode: string;
  objectSha: string;
  components: Array<{ path: string; kind: GitEntryKind; mode: string; objectSha: string }>;
  modificationEligible: boolean;
  content: string | null;
  contentHash: string | null;
}
export interface ExactGitReader {
  commit(sha: string, signal: AbortSignal): Promise<{ sha: string; tree: { sha: string } }>;
  tree(
    sha: string,
    signal: AbortSignal,
  ): Promise<{ sha: string; tree: Entry[]; truncated?: boolean }>;
  blob(
    sha: string,
    signal: AbortSignal,
  ): Promise<{ sha: string; size: number | null; encoding: string; content: string }>;
}
function fail(message: string): never {
  throw new GithubError('VALIDATION_FAILED', message, 400);
}
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function classify(entry: Entry): GitEntryKind {
  if (entry.type === 'tree' && entry.mode === '040000') return 'DIRECTORY';
  if (entry.type === 'commit' && entry.mode === '160000') return 'SUBMODULE';
  if (entry.type === 'blob' && entry.mode === '120000') return 'SYMLINK';
  if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode ?? ''))
    return 'REGULAR_FILE';
  return 'UNSUPPORTED';
}

/** Single exact-commit path walk; no recursive trees, symlink following or writes. */
export async function verifyExactGitFile(
  reader: ExactGitReader,
  revision: string,
  rawPath: string,
  options: { readContent?: boolean; signal?: AbortSignal } = {},
): Promise<ExactGitFile> {
  if (!RepositoryPathSchema.safeParse(rawPath).success) fail('Unsafe repository path');
  const parts = rawPath.split('/');
  if (
    parts.length > EXACT_GIT_LIMITS.depth ||
    parts.some(
      (p) =>
        /^\.git$/i.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    fail('Unsupported repository path');
  if (!/^[a-f0-9]{40}$/i.test(revision)) fail('Exact commit SHA required');
  revision = revision.toLowerCase();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(EXACT_GIT_LIMITS.deadlineMs)])
    : AbortSignal.timeout(EXACT_GIT_LIMITS.deadlineMs);
  const check = () => {
    if (signal.aborted) fail('Exact Git verification cancelled or timed out');
  };
  check();
  const commit = await reader.commit(revision, signal);
  check();
  if (commit.sha !== revision || !sha(commit.tree?.sha)) fail('Commit identity mismatch');
  let treeSha = commit.tree.sha;
  const components: ExactGitFile['components'] = [];
  for (let i = 0; i < parts.length; i++) {
    check();
    const tree = await reader.tree(treeSha, signal);
    check();
    if (
      tree.sha !== treeSha ||
      tree.truncated ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > EXACT_GIT_LIMITS.treeEntries
    )
      fail('Incomplete or mismatched Git tree');
    const matches = tree.tree.filter((e) => e.path?.toLowerCase() === parts[i]!.toLowerCase());
    if (matches.length > 1) fail('Ambiguous repository path');
    const entry = matches[0];
    if (!entry || entry.path !== parts[i])
      throw new GithubError('NOT_FOUND', 'Exact Git path not found', 404);
    if (!sha(entry.sha)) fail('Invalid Git object identity');
    const kind = classify(entry),
      mode = entry.mode ?? '';
    components.push({ path: parts.slice(0, i + 1).join('/'), kind, mode, objectSha: entry.sha });
    if (i < parts.length - 1 && kind === 'DIRECTORY') {
      treeSha = entry.sha;
      continue;
    }
    const result: ExactGitFile = {
      revision,
      path: rawPath,
      kind,
      mode,
      objectSha: entry.sha,
      components,
      modificationEligible: false,
      content: null,
      contentHash: null,
    };
    if (
      i < parts.length - 1 ||
      kind !== 'REGULAR_FILE' ||
      mode !== '100644' ||
      options.readContent === false
    )
      return result;
    if (
      entry.size != null &&
      (!Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > EXACT_GIT_LIMITS.blobBytes)
    )
      fail('Blob exceeds supported bounds');
    const blob = await reader.blob(entry.sha, signal);
    check();
    if (
      blob.sha !== entry.sha ||
      blob.encoding !== 'base64' ||
      typeof blob.size !== 'number' ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0 ||
      blob.size > EXACT_GIT_LIMITS.blobBytes
    )
      fail('Invalid or oversized Git blob');
    const encoded = blob.content.replace(/[\r\n]/g, '');
    if (
      encoded.length > 4 * Math.ceil(EXACT_GIT_LIMITS.blobBytes / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      fail('Invalid blob encoding');
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.length !== blob.size ||
      (entry.size != null && bytes.length !== entry.size) ||
      bytes.length > EXACT_GIT_LIMITS.blobBytes ||
      bytes.toString('base64') !== encoded
    )
      fail('Blob size or encoding mismatch');
    const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (digest !== entry.sha) fail('Blob identity mismatch');
    const text = bytes.toString('utf8');
    if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes))
      fail('Unsupported binary blob');
    return {
      ...result,
      modificationEligible: true,
      content: text,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return fail('Exact path verification incomplete');
}
