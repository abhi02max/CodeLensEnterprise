import {
  StrictRiskFeaturesSchema,
  classifyFile,
  detectLanguage,
  FileFlag,
  isAnalyzable,
  redactSecrets,
} from '@codelens/shared';
import { extractMetrics } from '@codelens/static-analysis';
import {
  STATIC_IDENTITY,
  staticInputDigest,
  staticSourceBound,
  type StaticFile,
} from '@codelens/static-analysis/dist/validation-static';
import { directDiff, DIRECT_DIFF_POLICY } from '@codelens/patch-core';
import { riskDigest } from '../ml/strict-risk-client';

export const ML_EXTRACTION = Object.freeze({
  extractorVersion: 'full-source-complexity-v1',
  diffPolicyVersion: DIRECT_DIFF_POLICY,
  staticPolicyVersion: 'severe-security-added-target-lines-v1',
  textNormalizationVersion: 'redacted-nfc-ascii-whitespace-v1',
  historicalPolicyVersion: 'assessment-start-review-history-path-set-v1',
});
export const ML_EXTRACTION_BOUNDS = Object.freeze({
  files: 100,
  bytes: 2097152,
  fileBytes: 131072,
  lines: 20000,
  diffLines: 20000,
  durationMs: 5000,
  historicalPaths: 1000,
  commits: 10000,
});
export type MlStaticEvidence = {
  status: string;
  sourceDigest: string;
  inputDigest: string;
  findingCount: number;
  rulesetVersion: string;
  rulesetDigest: string;
  configurationDigest: string;
  findings: Array<{
    path: string;
    startLine: number;
    endLine: number;
    severity: string;
    category: string;
  }>;
};
export function freezeMlMetadata(
  title: string,
  messages: string[],
  commitCount: number,
  riskyPaths: string[],
  capturedAt: string,
) {
  if (
    messages.length !== commitCount ||
    commitCount < 0 ||
    !Number.isInteger(commitCount) ||
    commitCount > ML_EXTRACTION_BOUNDS.commits ||
    riskyPaths.length > ML_EXTRACTION_BOUNDS.historicalPaths ||
    new Set(riskyPaths).size !== riskyPaths.length ||
    Buffer.byteLength(title) + messages.reduce((n, s) => n + Buffer.byteLength(s), 0) > 32768
  )
    throw new Error('ML_METADATA_UNAVAILABLE');
  // Redact before normalization; never persist original title/messages or the raw path inventory.
  const normalize = (s: string, max: number) => {
    const value = redactSecrets(s)
      .redacted.normalize('NFC')
      .replace(/[ \t\r\n\f\v]+/g, ' ')
      .trim();
    if (Array.from(value).length > max || /[\x00-\x1f\x7f]/.test(value))
      throw new Error('ML_METADATA_BOUND');
    return value;
  };
  const metadata = {
    provenance: 'ASSESSMENT_START_PERSISTED_METADATA' as const,
    capturedAt,
    commitCount,
    title: normalize(title, 300),
    commitText: normalize(messages.join(' \n '), 2000),
    riskyPathCount: riskyPaths.length,
    riskyPathDigest: riskDigest([...riskyPaths].sort()),
    historicalPolicyVersion: ML_EXTRACTION.historicalPolicyVersion,
  };
  return { metadata, digest: riskDigest(metadata), riskyPaths: new Set(riskyPaths) };
}
export type FrozenMlMetadata = ReturnType<typeof freezeMlMetadata>;
export function extractValidationMl(
  base: StaticFile[],
  target: StaticFile[],
  sourceDigest: string,
  evidence: MlStaticEvidence,
  frozen: FrozenMlMetadata,
  deadline = Date.now() + ML_EXTRACTION_BOUNDS.durationMs,
) {
  const check = () => {
    if (Date.now() >= deadline) throw new Error('ML_EXTRACTION_TIMEOUT');
  };
  for (const source of [base, target]) {
    check();
    if (
      staticSourceBound(source) ||
      source.reduce((n, f) => n + f.content.split('\n').length, 0) > ML_EXTRACTION_BOUNDS.lines
    )
      throw new Error('ML_SOURCE_BOUND');
  }
  if (
    evidence.status !== 'COMPLETE' ||
    evidence.sourceDigest !== sourceDigest ||
    evidence.inputDigest !== staticInputDigest(target) ||
    evidence.rulesetVersion !== STATIC_IDENTITY.rulesetVersion ||
    evidence.rulesetDigest !== STATIC_IDENTITY.rulesetDigest ||
    evidence.configurationDigest !== STATIC_IDENTITY.configurationDigest ||
    evidence.findingCount !== evidence.findings.length
  )
    throw new Error('ML_STATIC_UNAVAILABLE');
  const old = new Map(base.map((f) => [f.path, f.content])),
    next = new Map(target.map((f) => [f.path, f.content]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].sort();
  const changed = paths.filter((p) => old.get(p) !== next.get(p) && isAnalyzable(p));
  let added = 0,
    deleted = 0,
    complexity = 0,
    security = 0;
  const touched = new Map<string, Set<number>>();
  for (const path of changed) {
    check();
    const before = old.get(path) ?? '',
      after = next.get(path) ?? '';
    const d = directDiff(before, after, Math.max(1, Math.min(1000, deadline - Date.now())));
    added += d.additions;
    deleted += d.deletions;
    touched.set(path, d.touched);
    if (added + deleted > ML_EXTRACTION_BOUNDS.diffLines) throw new Error('ML_DIFF_BOUND');
    complexity += extractMetrics(
      {
        files: [
          {
            path,
            content: after,
            previousContent: before,
            language: detectLanguage(path),
            flags: classifyFile(path),
            analyzable: true,
            touchedLines: d.touched,
            additions: d.additions,
            deletions: d.deletions,
          },
        ],
        repoConfigFiles: [],
        manifests: {},
        extraSemgrepRulesets: [],
      },
      [],
    ).complexityDelta;
  }
  for (const f of evidence.findings) {
    check();
    const source = next.get(f.path);
    if (
      source === undefined ||
      f.startLine < 1 ||
      f.endLine < f.startLine ||
      f.endLine > source.split('\n').length
    )
      throw new Error('ML_STATIC_UNAVAILABLE');
    if (f.category === 'SECURITY' && ['HIGH', 'CRITICAL'].includes(f.severity)) {
      const lines = touched.get(f.path);
      if (lines && [...lines].some((line) => line >= f.startLine && line <= f.endLine)) security++;
    }
  }
  const flag = (f: FileFlag) => (changed.some((p) => classifyFile(p).includes(f)) ? 1 : 0);
  check();
  const features = StrictRiskFeaturesSchema.parse({
    lines_added: added,
    lines_deleted: deleted,
    files_changed: changed.length,
    complexity_delta: complexity,
    security_findings_count: security,
    dependency_changed: flag(FileFlag.DEPENDENCY),
    test_files_changed: flag(FileFlag.TEST),
    auth_file_changed: flag(FileFlag.AUTH),
    database_file_changed: flag(FileFlag.DATABASE),
    config_file_changed: flag(FileFlag.CONFIG),
    payment_file_changed: flag(FileFlag.PAYMENT),
    previous_risky_file_count: changed.filter((p) => frozen.riskyPaths.has(p)).length,
    number_of_commits: frozen.metadata.commitCount,
    title_text: frozen.metadata.title,
    commit_text: frozen.metadata.commitText,
  });
  return { features, featureDigest: riskDigest(features) };
}
