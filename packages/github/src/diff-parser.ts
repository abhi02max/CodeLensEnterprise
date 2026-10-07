import {
  FileChangeStatus,
  type DiffHunk,
  type DiffLine,
  type ParsedFileDiff,
  type TouchedLineMap,
} from '@codelens/shared';

/**
 * Unified diff parsing.
 *
 * GitHub returns a `patch` string per file rather than structured hunks, and
 * almost everything downstream needs the structure:
 *
 *   - static analysis needs the set of touched line numbers, so a finding on an
 *     untouched line can be marked pre-existing instead of blamed on the author
 *   - the secret scanner needs added lines only, because a PR that *removes* a
 *     hardcoded key is the behaviour we want to encourage
 *   - the RAG retriever needs added/removed content separately to build a query
 *   - the diff viewer needs old and new line numbers for inline comment anchors
 *
 * Deliberately hand-written rather than pulled from a library: the format is
 * small and stable, and the line-number bookkeeping is the part that has to be
 * exactly right for comment anchoring to work.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedPatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = patch.split('\n');

  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    const headerMatch = HUNK_HEADER.exec(raw);

    if (headerMatch) {
      if (current) hunks.push(current);

      const oldStart = Number(headerMatch[1] ?? 0);
      const newStart = Number(headerMatch[3] ?? 0);

      current = {
        header: raw,
        oldStart,
        // A count of 1 is omitted in the header, so absent means 1.
        oldLines: headerMatch[2] === undefined ? 1 : Number(headerMatch[2]),
        newStart,
        newLines: headerMatch[4] === undefined ? 1 : Number(headerMatch[4]),
        lines: [],
      };

      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!current) continue;

    // "\ No newline at end of file" is metadata, not content.
    if (raw.startsWith('\\')) continue;

    const marker = raw.charAt(0);
    const content = raw.slice(1);

    if (marker === '+') {
      current.lines.push({
        type: 'add',
        newLineNumber: newLine,
        oldLineNumber: null,
        content,
      });
      newLine += 1;
    } else if (marker === '-') {
      current.lines.push({
        type: 'del',
        newLineNumber: null,
        oldLineNumber: oldLine,
        content,
      });
      oldLine += 1;
    } else if (marker === ' ' || raw === '') {
      current.lines.push({
        type: 'context',
        newLineNumber: newLine,
        oldLineNumber: oldLine,
        content,
      });
      oldLine += 1;
      newLine += 1;
    }
    // Anything else (diff headers leaking into the patch) is skipped.
  }

  if (current) hunks.push(current);
  return hunks;
}

export function mapFileStatus(status: string): FileChangeStatus {
  switch (status) {
    case 'added':
      return FileChangeStatus.ADDED;
    case 'removed':
      return FileChangeStatus.REMOVED;
    case 'modified':
      return FileChangeStatus.MODIFIED;
    case 'renamed':
      return FileChangeStatus.RENAMED;
    case 'copied':
      return FileChangeStatus.COPIED;
    case 'changed':
      return FileChangeStatus.CHANGED;
    case 'unchanged':
      return FileChangeStatus.UNCHANGED;
    default:
      return FileChangeStatus.MODIFIED;
  }
}

export interface RawGithubFile {
  filename: string;
  previous_filename?: string | undefined;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | undefined;
}

export function parseFileDiff(file: RawGithubFile): ParsedFileDiff {
  // GitHub omits `patch` for binary files and for files whose diff exceeds its
  // own size limits. Both cases are legitimately unreviewable line by line.
  // Omission alone cannot distinguish binary content from a remote size limit.
  const binary = false;

  return {
    filename: file.filename,
    previousFilename: file.previous_filename ?? null,
    status: mapFileStatus(file.status),
    hunks: file.patch ? parseUnifiedPatch(file.patch) : [],
    additions: file.additions,
    deletions: file.deletions,
    binary,
  };
}

// ---------------------------------------------------------------- derived views

/** Line numbers (in the new file) that the PR added or modified. */
export function touchedLineNumbers(hunks: readonly DiffHunk[]): number[] {
  const touched = new Set<number>();

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add' && line.newLineNumber !== null) {
        touched.add(line.newLineNumber);
      }
    }
  }

  return [...touched].sort((a, b) => a - b);
}

/**
 * Touched lines across the whole PR.
 *
 * Deletions get special treatment: a removed line has no position in the new
 * file, so the *surrounding* new-file lines are marked instead. Otherwise a
 * finding about "this guard disappeared" has nowhere to attach.
 */
export function buildTouchedLineMap(files: readonly ParsedFileDiff[]): TouchedLineMap {
  const map: TouchedLineMap = new Map();

  for (const file of files) {
    const touched = new Set<number>(touchedLineNumbers(file.hunks));

    for (const hunk of file.hunks) {
      for (const [index, line] of hunk.lines.entries()) {
        if (line.type !== 'del') continue;

        const before = findNearbyNewLine(hunk.lines, index, -1);
        const after = findNearbyNewLine(hunk.lines, index, 1);
        if (before !== null) touched.add(before);
        if (after !== null) touched.add(after);
      }
    }

    map.set(file.filename, touched);
  }

  return map;
}

function findNearbyNewLine(
  lines: readonly DiffLine[],
  from: number,
  direction: 1 | -1,
): number | null {
  for (let i = from + direction; i >= 0 && i < lines.length; i += direction) {
    const candidate = lines[i];
    if (candidate?.newLineNumber !== null && candidate?.newLineNumber !== undefined) {
      return candidate.newLineNumber;
    }
  }
  return null;
}

export interface AddedLine {
  line: number;
  content: string;
}

/** Added lines with their new-file line numbers. Feeds the secret scanner. */
export function addedLines(hunks: readonly DiffHunk[]): AddedLine[] {
  const result: AddedLine[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add' && line.newLineNumber !== null) {
        result.push({ line: line.newLineNumber, content: line.content });
      }
    }
  }

  return result;
}

export function removedLines(hunks: readonly DiffHunk[]): AddedLine[] {
  const result: AddedLine[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'del' && line.oldLineNumber !== null) {
        result.push({ line: line.oldLineNumber, content: line.content });
      }
    }
  }

  return result;
}

/** One line of reconstructed content, with its position in each side of the change. */
export interface ReconstructedLine {
  content: string;
  /** Position in the post-change file. Null only for a line that was removed. */
  newLineNumber: number | null;
  /** Position in the pre-change file. Null for a line that was added. */
  oldLineNumber: number | null;
}

export interface ReconstructedSides {
  before: string;
  after: string;
  /** Parallel to `after.split('\n')`. */
  afterLines: ReconstructedLine[];
  /** Parallel to `before.split('\n')`. */
  beforeLines: ReconstructedLine[];
}

/**
 * Reconstruct partial "before" and "after" file content from the diff.
 *
 * Only the regions the diff covers, which is exactly what the complexity
 * analyzer needs to compute a before/after delta without fetching both full
 * blobs from GitHub — two extra API calls per file adds up fast on a large PR.
 *
 * The line arrays exist because the joined strings are *fragments*: index 0 of
 * `after` is wherever the first hunk starts, not line 1 of the file. Any analyzer
 * that matches a line and wants to report where it is needs the mapping back, and
 * without it the only thing available was a guess. `parseUnifiedPatch` already
 * tracked these numbers; this stops throwing them away.
 */
export function reconstructSides(hunks: readonly DiffHunk[]): ReconstructedSides {
  const before: ReconstructedLine[] = [];
  const after: ReconstructedLine[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const entry: ReconstructedLine = {
        content: line.content,
        newLineNumber: line.newLineNumber,
        oldLineNumber: line.oldLineNumber,
      };

      if (line.type === 'add') {
        after.push(entry);
      } else if (line.type === 'del') {
        before.push(entry);
      } else {
        before.push(entry);
        after.push(entry);
      }
    }
  }

  return {
    before: before.map((line) => line.content).join('\n'),
    after: after.map((line) => line.content).join('\n'),
    afterLines: after,
    beforeLines: before,
  };
}

/**
 * Identifiers appearing in added or removed lines.
 *
 * These drive the lexical half of hybrid retrieval. Vector search alone reliably
 * misses exact symbol matches: a diff that calls `recordRefund` may not rank the
 * chunk defining `recordRefund` highly, because the two share little other
 * vocabulary. A literal identifier match finds it immediately.
 */
export function extractIdentifiers(hunks: readonly DiffHunk[], limit = 60): string[] {
  const counts = new Map<string, number>();

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') continue;

      // camelCase, PascalCase and snake_case identifiers of 4+ chars.
      const matches = line.content.match(/\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g);
      if (!matches) continue;

      for (const raw of matches) {
        if (LANGUAGE_KEYWORDS.has(raw)) continue;
        if (looksLikeSecretValue(raw)) continue;
        counts.set(raw, (counts.get(raw) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([identifier]) => identifier);
}

/** Import specifiers added or removed, used to seed import-graph retrieval. */
export function extractImportSpecifiers(hunks: readonly DiffHunk[]): string[] {
  const specifiers = new Set<string>();

  const patterns = [
    /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/,
    /require\(\s*['"]([^'"]+)['"]\s*\)/,
    /^\s*from\s+([\w.]+)\s+import\s+/,
    /^\s*import\s+([\w.]+)/,
  ];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') continue;

      for (const pattern of patterns) {
        const match = pattern.exec(line.content);
        if (match?.[1]) specifiers.add(match[1]);
      }
    }
  }

  return [...specifiers];
}

/**
 * Diff text prepared for an LLM or an embedding call.
 *
 * Context lines are capped rather than dropped: the model needs some surrounding
 * code to judge a change, but a hunk with 30 lines of untouched context wastes
 * most of its token budget on code nobody is reviewing.
 */
export function formatHunksForPrompt(
  hunks: readonly DiffHunk[],
  options: { maxContextLines?: number; maxTotalLines?: number } = {},
): string {
  const { maxContextLines = 3, maxTotalLines = 400 } = options;
  const output: string[] = [];
  let emitted = 0;

  for (const hunk of hunks) {
    if (emitted >= maxTotalLines) {
      output.push('… diff truncated for length …');
      break;
    }

    output.push(hunk.header);

    let contextRun = 0;
    for (const line of hunk.lines) {
      if (emitted >= maxTotalLines) break;

      if (line.type === 'context') {
        contextRun += 1;
        if (contextRun > maxContextLines) continue;
      } else {
        contextRun = 0;
      }

      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      const lineNumber = line.newLineNumber ?? line.oldLineNumber ?? 0;
      output.push(`${String(lineNumber).padStart(5)} ${marker}${line.content}`);
      emitted += 1;
    }
  }

  return output.join('\n');
}

/**
 * Reject high-entropy tokens from identifier extraction.
 *
 * Without this, a hardcoded credential in the diff is extracted as an
 * "identifier" and then forwarded to the retriever and the embedding provider —
 * which is precisely the data path the secret scanner exists to protect. The
 * scanner runs earlier and can redact, but identifier extraction must not
 * reintroduce the value on its own.
 *
 * Real identifiers, even long ones, have low entropy because they are built from
 * dictionary words and repeated casing patterns. Random key material does not.
 */
function looksLikeSecretValue(token: string): boolean {
  if (token.length < 20) return false;

  // Identifiers use word boundaries; key material generally does not.
  const hasWordStructure = /^[a-z]+([A-Z][a-z]+)+$/.test(token) || token.includes('_');
  if (hasWordStructure) return false;

  return shannonEntropyOf(token) > 3.5;
}

function shannonEntropyOf(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Keywords excluded from identifier extraction across the languages we handle. */
const LANGUAGE_KEYWORDS = new Set([
  'const', 'this', 'function', 'return', 'import', 'export', 'from', 'class',
  'async', 'await', 'true', 'false', 'null', 'undefined', 'void', 'type',
  'interface', 'extends', 'implements', 'public', 'private', 'protected',
  'static', 'readonly', 'string', 'number', 'boolean', 'object', 'else',
  'while', 'break', 'continue', 'switch', 'case', 'default', 'throw', 'catch',
  'finally', 'typeof', 'instanceof', 'delete', 'yield', 'super', 'enum',
  'namespace', 'declare', 'module', 'require', 'self', 'None', 'True', 'False',
  'def', 'elif', 'lambda', 'pass', 'raise', 'except', 'import', 'global',
  'nonlocal', 'assert', 'struct', 'impl', 'trait', 'match', 'let', 'mut',
  'func', 'package', 'defer', 'range', 'chan', 'select', 'var',
]);
