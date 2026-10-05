import { describe, expect, it } from 'vitest';
import {
  STATIC_IDENTITY,
  staticInputDigest,
} from '@codelens/static-analysis/dist/validation-static';
import {
  extractValidationMl,
  freezeMlMetadata,
  type MlStaticEvidence,
} from './validation-ml-content';
const frozen = () =>
  freezeMlMetadata('  Review  #1 ', ['message'], 1, ['src/auth.ts'], '2026-10-05T00:00:00Z');
const evidence = (
  files: Array<{ path: string; content: string }>,
  findings: MlStaticEvidence['findings'] = [],
): MlStaticEvidence => ({
  ...STATIC_IDENTITY,
  status: 'COMPLETE',
  sourceDigest: 'a'.repeat(64),
  inputDigest: staticInputDigest(files),
  findingCount: findings.length,
  findings,
});
const feature = (
  base: Array<{ path: string; content: string }>,
  target: Array<{ path: string; content: string }>,
  e = evidence(target),
) => extractValidationMl(base, target, 'a'.repeat(64), e, frozen());
describe('direct BASE comparison extraction', () => {
  it('uses full-source complexity only for the existing supported languages', () => {
    const before = 'export function run(input: string) { return input; }\n';
    const after = 'export function run(input: string) { if (input) return input; return ""; }\n';
    expect(
      feature([{ path: 'a.ts', content: before }], [{ path: 'a.ts', content: after }]).features
        .complexity_delta,
    ).toBe(1);
    expect(
      feature([{ path: 'README.md', content: before }], [{ path: 'README.md', content: after }])
        .features.complexity_delta,
    ).toBe(0);
  });
  it('uses all existing path flags without adding model features', () => {
    const target = [
      'package.json',
      'tests/auth.test.ts',
      'src/auth/login.ts',
      'src/migrations/schema.sql',
      'config/settings.json',
      'src/payments/charge.ts',
    ].map((path) => ({ path, content: 'value\n' }));
    const f = feature([], target).features;
    for (const name of [
      'dependency_changed',
      'test_files_changed',
      'auth_file_changed',
      'database_file_changed',
      'config_file_changed',
      'payment_file_changed',
    ] as const)
      expect(f[name]).toBe(1);
    expect(Object.keys(f)).toHaveLength(15);
  });
  it('counts direct additions/deletions and reuses frozen title/commits', () => {
    const base = [{ path: 'src/auth.ts', content: 'a\nb\n' }],
      target = [{ path: 'src/auth.ts', content: 'a\nc\nd\n' }];
    const f = feature(base, target).features;
    expect(f.lines_added).toBe(2);
    expect(f.lines_deleted).toBe(1);
    expect(f.files_changed).toBe(1);
    expect(f.previous_risky_file_count).toBe(1);
    expect(f.auth_file_changed).toBe(1);
    expect(f.title_text).toBe('Review #1');
    expect(f.commit_text).toBe('message');
    expect(f.number_of_commits).toBe(1);
    expect(feature(base, target)).toEqual(feature(base, target));
  });
  it('counts only severe SECURITY occurrences touching added target lines', () => {
    const base = [{ path: 'src/auth.ts', content: 'same\nold\n' }],
      target = [{ path: 'src/auth.ts', content: 'same\nnew\n' }];
    const findings = [1, 2].map((line) => ({
      path: 'src/auth.ts',
      startLine: line,
      endLine: line,
      severity: 'HIGH',
      category: 'SECURITY',
    }));
    expect(feature(base, target, evidence(target, findings)).features.security_findings_count).toBe(
      1,
    );
    expect(
      feature(base, target, evidence(target, [{ ...findings[1]!, category: 'BUG' }])).features
        .security_findings_count,
    ).toBe(0);
    expect(
      feature(base, target, evidence(target, [{ ...findings[1]!, severity: 'MEDIUM' }])).features
        .security_findings_count,
    ).toBe(0);
  });
  it.each(['FAILED', 'TRUNCATED', 'TIMED_OUT', 'UNSUPPORTED'])(
    'rejects %s static evidence rather than inventing zero',
    (status) => {
      const target = [{ path: 'a.ts', content: 'value\n' }];
      expect(() => feature([], target, { ...evidence(target), status })).toThrow(
        'ML_STATIC_UNAVAILABLE',
      );
    },
  );
  it.each(['sourceDigest', 'inputDigest', 'rulesetDigest', 'configurationDigest'])(
    'rejects wrong %s identity',
    (field) => {
      const target = [{ path: 'a.ts', content: 'value\n' }];
      expect(() => feature([], target, { ...evidence(target), [field]: 'b'.repeat(64) })).toThrow(
        'ML_STATIC_UNAVAILABLE',
      );
    },
  );
  it('handles deletions and no change without a fake risk result', () => {
    expect(feature([{ path: 'a.ts', content: 'one\ntwo\n' }], []).features.lines_deleted).toBe(2);
    const files = [{ path: 'a.ts', content: 'one\n' }];
    expect(feature(files, files).features.files_changed).toBe(0);
  });
  it('bounds source/lines and extraction deadline', () => {
    const files = [{ path: 'a.ts', content: 'x'.repeat(2001) }];
    expect(() => feature([], files)).toThrow('ML_SOURCE_BOUND');
    expect(() => extractValidationMl([], [], 'a'.repeat(64), evidence([]), frozen(), 0)).toThrow(
      'ML_EXTRACTION_TIMEOUT',
    );
  });
  it('fails incomplete commits and oversized metadata', () => {
    expect(() => freezeMlMetadata('title', [], 1, [], 'now')).toThrow('ML_METADATA_UNAVAILABLE');
    expect(() => freezeMlMetadata('x'.repeat(301), [], 0, [], 'now')).toThrow('ML_METADATA_BOUND');
    expect(() => freezeMlMetadata('title', [], 0, Array(1001).fill('a'), 'now')).toThrow();
  });
  it('redacts metadata and persists only the risky-path digest/count', () => {
    const f = frozen();
    expect(f.metadata).not.toHaveProperty('riskyPaths');
    expect(f.metadata.riskyPathCount).toBe(1);
    expect(f.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
