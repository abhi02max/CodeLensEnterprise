import { createHash } from 'node:crypto';
import {
  detectLanguage,
  RepositoryPathSchema,
  SECRET_PATTERNS,
  redactSecrets,
  type StaticClass,
  type StaticStatus,
} from '@codelens/shared';
import { runPatternScan, PATTERN_RULE_IDENTITY } from './analyzers/pattern-scan';
import { runSecretScan } from './analyzers/secret-scan';
import type { AnalyzerInput } from './types';

export const STATIC_BOUNDS = Object.freeze({
  files: 100,
  bytes: 2 * 1024 * 1024,
  fileBytes: 128 * 1024,
  lineCharacters: 2000,
  findings: 500,
  message: 700,
  context: 10016,
  durationMs: 5000,
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const STATIC_IDENTITY = Object.freeze({
  rulesetVersion: 'codelens-pure-static-v1',
  fingerprintVersion: 'occurrence-v1',
  rulesetDigest: hash([
    PATTERN_RULE_IDENTITY,
    SECRET_PATTERNS.map((p) => [p.kind, p.pattern.source, p.pattern.flags, p.confidence]),
    runPatternScan.toString(),
    runSecretScan.toString(),
  ]),
  configurationDigest: hash({
    bounds: STATIC_BOUNDS,
    fullSource: true,
    rules: 'pattern+secret',
    normalization: 'trim-only-v1',
    comparison: 'unique-content-then-exact-edit-mapping-v2',
    excludedRules: ['codelens/dropped-guard-clause'],
  }),
});
export type StaticFile = { path: string; content: string };
export type StaticEdit = { startLine: number; endLine: number; replacement: string };
export type StaticEdits = Array<{ path: string; edits: StaticEdit[] }>;
export interface StaticOccurrence {
  analyzer: string;
  ruleId: string;
  severity: string;
  category: string;
  path: string;
  startLine: number;
  endLine: number;
  message: string;
  occurrenceFingerprint: string;
  relevantDigest: string;
  findingDigest: string;
  classification: StaticClass;
  comparability: string;
  counterpartDigest: string | null;
  diffRelation: 'EDITED_RANGE' | 'CHANGED_FILE' | 'UNCHANGED_FILE';
}
export interface StaticResult {
  status: StaticStatus;
  reason: string | null;
  inputDigest: string;
  identity: typeof STATIC_IDENTITY;
  findings: StaticOccurrence[];
}
export const staticInputDigest = (files: StaticFile[]) =>
  hash([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => [f.path, hash(f.content)]));
const normalize = (s: string) => redactSecrets(s).redacted.trim();

export function staticSourceBound(files: StaticFile[]): string | null {
  if (files.length > STATIC_BOUNDS.files) return 'FILE_COUNT_BOUND';
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = RepositoryPathSchema.safeParse(file.path);
    if (
      !parsed.success ||
      parsed.data !== file.path ||
      file.path.length > 512 ||
      file.path.split('/').some((p) => p.toLowerCase() === '.git') ||
      redactSecrets(file.path).redacted !== file.path ||
      seen.has(file.path.toLowerCase())
    )
      return 'PATH_REJECTED';
    seen.add(file.path.toLowerCase());
    const size = Buffer.byteLength(file.content);
    if (size > STATIC_BOUNDS.fileBytes) return 'FILE_BYTE_BOUND';
    bytes += size;
    if (bytes > STATIC_BOUNDS.bytes) return 'REPOSITORY_BYTE_BOUND';
    if (file.content.includes('\0') || Buffer.from(file.content).toString('utf8') !== file.content)
      return 'TEXT_REJECTED';
    // Both legacy scanners skip long lines. Never represent that omission as complete coverage.
    if (file.content.split('\n').some((line) => line.length > STATIC_BOUNDS.lineCharacters))
      return 'LINE_BOUND';
  }
  return null;
}

function ranges(edits: StaticEdit[], patched: boolean) {
  let offset = 0;
  return [...edits]
    .sort((a, b) => a.startLine - b.startLine)
    .map((e) => {
      const length = e.replacement.split('\n').length;
      const start = e.startLine + offset;
      offset += length - (e.endLine - e.startLine + 1);
      return patched ? [start, start + length - 1] : [e.startLine, e.endLine];
    });
}
export function analyzeStaticSource(
  files: StaticFile[],
  side: 'ORIGINAL' | 'PATCHED',
  edits: StaticEdits,
): StaticResult {
  const inputDigest = staticInputDigest(files);
  const rejected = staticSourceBound(files);
  const base = { inputDigest, identity: STATIC_IDENTITY, findings: [] as StaticOccurrence[] };
  if (rejected) return { ...base, status: 'UNSUPPORTED', reason: rejected };
  const input: AnalyzerInput = {
    files: [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => ({
        ...f,
        previousContent: '',
        language: detectLanguage(f.path),
        flags: [],
        analyzable: true,
        touchedLines: new Set(f.content.split('\n').map((_, i) => i + 1)),
        additions: 0,
        deletions: 0,
      })),
    repoConfigFiles: [],
    manifests: {},
    extraSemgrepRulesets: [],
  };
  // This historical diff rule describes a removal; positive whole-source matches cannot prove it.
  const raw = [...runPatternScan(input).findings, ...runSecretScan(input).findings].filter(
    (f) => f.ruleId !== 'codelens/dropped-guard-clause',
  );
  if (raw.length > STATIC_BOUNDS.findings)
    return { ...base, status: 'TRUNCATED', reason: 'FINDING_COUNT_BOUND' };
  const findings = raw.map((f) => {
    const line = f.line!,
      lines = files.find((p) => p.path === f.path)!.content.split('\n');
    const secret = f.analyzer === 'SECRET_SCAN';
    const construct = normalize(lines[line - 1]!);
    // This bounded context affects rule confirmations only. It never includes unredacted source.
    const relevant = /raw-sql/.test(f.ruleId)
      ? normalize(lines.slice(Math.max(0, line - 2), line + 3).join('\n'))
      : construct;
    const sourceRedacted =
      redactSecrets(lines[line - 1]!).count > 0 ||
      (/raw-sql/.test(f.ruleId) &&
        redactSecrets(lines.slice(Math.max(0, line - 2), line + 3).join('\n')).count > 0);
    const occurrenceFingerprint = hash([
      STATIC_IDENTITY.fingerprintVersion,
      f.analyzer,
      f.ruleId,
      f.path,
      construct,
    ]);
    const relevantDigest = hash([relevant, f.severity]);
    const fileEdits = edits.find((e) => e.path === f.path);
    const intersect =
      fileEdits &&
      ranges(fileEdits.edits, side === 'PATCHED').some(
        ([start, end]) => line >= start! && line <= end!,
      );
    const normalized = {
      analyzer: f.analyzer,
      ruleId: f.ruleId,
      severity: f.severity,
      category: f.category,
      path: f.path!,
      startLine: line,
      endLine: f.endLine ?? line,
      message: secret
        ? 'Possible committed credential detected. Value and snippet withheld; rotate if genuine.'
        : f.ruleId === 'codelens/todo-in-sensitive-path'
          ? 'An unresolved TODO, FIXME, HACK or XXX marker was detected in this source snapshot.'
          : f.message.slice(0, STATIC_BOUNDS.message),
      occurrenceFingerprint,
      relevantDigest,
      diffRelation: intersect
        ? ('EDITED_RANGE' as const)
        : fileEdits
          ? ('CHANGED_FILE' as const)
          : ('UNCHANGED_FILE' as const),
    };
    return {
      ...normalized,
      findingDigest: hash(normalized),
      classification: 'INCOMPARABLE' as const,
      comparability: secret || sourceRedacted ? 'SECRET_VALUE_WITHHELD' : 'UNMATCHED',
      counterpartDigest: null,
    };
  });
  return { ...base, status: 'COMPLETE', reason: null, findings };
}

/** Maps an exact original line through immutable disjoint edits; never fuzzy-matches source. */
function mappedLine(line: number, edits: StaticEdit[], reverse = false): number | null {
  let offset = 0;
  for (const e of [...edits].sort((a, b) => a.startLine - b.startLine)) {
    const size = e.replacement.split('\n').length;
    const originalSize = e.endLine - e.startLine + 1;
    const start = reverse ? e.startLine + offset : e.startLine;
    const end = reverse ? start + size - 1 : e.endLine;
    if (line < start) break;
    if (line <= end) return size === originalSize ? line + (reverse ? -offset : offset) : null;
    offset += size - (e.endLine - e.startLine + 1);
  }
  return line + (reverse ? -offset : offset);
}
export function compareStaticOccurrences(
  original: StaticResult,
  patched: StaticResult,
  edits: StaticEdits,
) {
  const a = structuredClone(original),
    b = structuredClone(patched);
  const all = [...a.findings, ...b.findings];
  if (
    a.status !== 'COMPLETE' ||
    b.status !== 'COMPLETE' ||
    JSON.stringify(a.identity) !== JSON.stringify(b.identity)
  ) {
    for (const f of all) {
      f.classification = 'INCOMPARABLE';
      f.comparability = 'INCOMPLETE_OR_IDENTITY_MISMATCH';
    }
    return { ORIGINAL: a, PATCHED: b };
  }
  const used = new Set<StaticOccurrence>();
  const pair = (
    x: StaticOccurrence,
    y: StaticOccurrence,
    classification: StaticClass,
    reason: string,
  ) => {
    x.classification = y.classification = classification;
    x.comparability = y.comparability = reason;
    x.counterpartDigest = y.findingDigest;
    y.counterpartDigest = x.findingDigest;
    used.add(x);
    used.add(y);
  };
  const duplicates = new Set<string>();
  for (const list of [a.findings, b.findings]) {
    const counts = new Map<string, number>();
    for (const f of list)
      counts.set(f.occurrenceFingerprint, (counts.get(f.occurrenceFingerprint) ?? 0) + 1);
    for (const [key, n] of counts) if (n > 1) duplicates.add(key);
  }
  for (const x of a.findings) {
    if (duplicates.has(x.occurrenceFingerprint)) continue;
    const y = b.findings.find(
      (f) =>
        f.occurrenceFingerprint === x.occurrenceFingerprint &&
        !duplicates.has(f.occurrenceFingerprint),
    );
    if (y) {
      const redacted =
        x.comparability === 'SECRET_VALUE_WITHHELD' || y.comparability === 'SECRET_VALUE_WITHHELD';
      pair(
        x,
        y,
        redacted ? 'INCOMPARABLE' : x.relevantDigest === y.relevantDigest ? 'UNCHANGED' : 'CHANGED',
        redacted ? 'SECRET_VALUE_WITHHELD' : 'UNIQUE_OCCURRENCE',
      );
    }
  }
  for (const x of a.findings.filter(
    (f) => !used.has(f) && !duplicates.has(f.occurrenceFingerprint),
  )) {
    const target = mappedLine(x.startLine, edits.find((e) => e.path === x.path)?.edits ?? []);
    const candidates = b.findings.filter(
      (y) =>
        !used.has(y) &&
        !duplicates.has(y.occurrenceFingerprint) &&
        y.path === x.path &&
        y.ruleId === x.ruleId &&
        y.analyzer === x.analyzer &&
        y.startLine === target,
    );
    if (candidates.length === 1) {
      const redacted =
        x.comparability === 'SECRET_VALUE_WITHHELD' ||
        candidates[0]!.comparability === 'SECRET_VALUE_WITHHELD';
      pair(
        x,
        candidates[0]!,
        redacted ? 'INCOMPARABLE' : 'CHANGED',
        redacted ? 'SECRET_VALUE_WITHHELD' : 'EXACT_EDIT_MAPPING',
      );
    }
  }
  for (const [list, other, classification] of [
    [a.findings, b.findings, 'RESOLVED'],
    [b.findings, a.findings, 'INTRODUCED'],
  ] as const) {
    for (const f of list.filter((f) => !used.has(f))) {
      const target = mappedLine(
        f.startLine,
        edits.find((e) => e.path === f.path)?.edits ?? [],
        classification === 'INTRODUCED',
      );
      // Exact one-to-one replacement mapping can prove local absence despite unrelated
      // same-rule occurrences elsewhere. Unequal ranges and duplicate identities cannot.
      const exactAbsence =
        f.diffRelation === 'EDITED_RANGE' &&
        f.startLine === f.endLine &&
        target !== null &&
        !other.some(
          (o) =>
            o.analyzer === f.analyzer &&
            o.ruleId === f.ruleId &&
            o.path === f.path &&
            o.startLine <= target &&
            o.endLine >= target,
        );
      const ambiguous =
        duplicates.has(f.occurrenceFingerprint) ||
        (!exactAbsence &&
          other.some(
            (o) =>
              !used.has(o) &&
              o.analyzer === f.analyzer &&
              o.ruleId === f.ruleId &&
              o.path === f.path,
          ));
      f.classification = ambiguous ? 'INCOMPARABLE' : classification;
      f.comparability = ambiguous
        ? 'AMBIGUOUS_OCCURRENCE'
        : exactAbsence
          ? 'EXACT_EDIT_MAPPED_ABSENCE'
          : 'ABSENT_ON_OTHER_COMPLETE_SIDE';
    }
  }
  return { ORIGINAL: a, PATCHED: b };
}
