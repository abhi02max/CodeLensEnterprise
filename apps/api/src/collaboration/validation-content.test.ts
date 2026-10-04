import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { hash } from '@codelens/validation-executor';
import { ValidationRequestSchema } from '@codelens/shared';
import {
  aggregateComparisons,
  compareSteps,
  compatibleFiles,
  stepOutcome,
  verifiedObservation,
} from './validation-content';

export function observation(
  profile: 'typescript-typecheck-v1' | 'vitest-unit-v1' = 'typescript-typecheck-v1',
) {
  return {
    version: 1 as const,
    profile,
    profileVersion: 1 as const,
    policyVersion: 'validation-local-v1' as const,
    image: 'sha256:' + 'a'.repeat(64),
    bundleDigest: 'b'.repeat(64),
    configurationDigest: 'c'.repeat(64),
    correlation: randomUUID(),
    inputDigest: 'd'.repeat(64),
    status: 'VALIDATION_EXECUTED' as string,
    observed: {
      started: true,
      exitCode: 0 as number | null,
      termination: 'EXITED',
      oom: false,
      durationMs: 100,
      cleanup: 'DISPOSED',
      stdout: { digest: hash(''), capturedBytes: 0, excerpt: '', complete: true },
      stderr: { digest: hash(''), capturedBytes: 0, excerpt: '', complete: true },
    },
    runnerReported: {
      trusted: false as const,
      status: 'VALID',
      reportDigest: hash('report'),
      report: {
        version: 1 as const,
        kind: profile === 'typescript-typecheck-v1' ? 'typecheck' : 'tests',
        passed: 1,
        failed: 0,
        total: 1,
      },
    },
  };
}
it.each([
  ['PASS', 'PASS', 'BOTH_PASS'],
  ['PASS', 'FAIL', 'ORIGINAL_PASS_PATCHED_FAIL'],
  ['FAIL', 'PASS', 'ORIGINAL_FAIL_PATCHED_PASS'],
  ['FAIL', 'FAIL', 'BOTH_FAIL'],
  ['UNSUPPORTED', 'PASS', 'UNSUPPORTED'],
  ['INCONCLUSIVE', 'PASS', 'INCONCLUSIVE'],
])('compares %s / %s without causality claims', (a, b, outcome) =>
  expect(compareSteps(a, b)).toBe(outcome),
);
it('retains per-profile mixed comparisons instead of inventing an overall improvement', () => {
  expect(aggregateComparisons(['BOTH_PASS', 'ORIGINAL_FAIL_PATCHED_PASS'])).toBe(
    'ORIGINAL_FAIL_PATCHED_PASS',
  );
  expect(aggregateComparisons(['ORIGINAL_FAIL_PATCHED_PASS', 'ORIGINAL_PASS_PATCHED_FAIL'])).toBe(
    'INCONCLUSIVE',
  );
});
it('legitimate typecheck and test failures remain successful observations', () => {
  for (const profile of ['typescript-typecheck-v1', 'vitest-unit-v1'] as const) {
    const r = observation(profile);
    expect(stepOutcome(r)).toBe('PASS');
    r.observed.exitCode = 1;
    r.runnerReported.report.passed = 0;
    r.runnerReported.report.failed = 1;
    expect(stepOutcome(r)).toBe('FAIL');
    expect(r.status).toBe('VALIDATION_EXECUTED');
  }
});
it.each(['TIMEOUT', 'OUTPUT_LIMIT', 'INFRASTRUCTURE', 'CANCELLED'])(
  'classifies %s as inconclusive',
  (termination) => {
    const r = observation();
    r.observed.termination = termination;
    expect(stepOutcome(r)).toBe('INCONCLUSIVE');
  },
);
it('OOM, malformed, missing, empty and inconsistent runner reports cannot establish pass', () => {
  const r = observation();
  r.observed.oom = true;
  expect(stepOutcome(r)).toBe('INCONCLUSIVE');
  r.observed.oom = false;
  r.runnerReported.status = 'REJECTED';
  expect(stepOutcome(r)).toBe('INCONCLUSIVE');
  r.runnerReported.status = 'MISSING';
  expect(stepOutcome(r)).toBe('INCONCLUSIVE');
  r.runnerReported.status = 'VALID';
  r.runnerReported.report.passed = 0;
  r.runnerReported.report.total = 0;
  expect(stepOutcome(r)).toBe('INCONCLUSIVE');
  r.runnerReported.report.total = 1;
  expect(() => stepOutcome(r)).toThrow();
});
it('binds input, nonce, image, bundle, config, profile and rejects oversized output', () => {
  const r = observation(),
    identity = {
      profile: r.profile,
      image: r.image,
      bundleDigest: r.bundleDigest,
      configurationDigest: r.configurationDigest,
      nonce: r.correlation,
      inputDigest: r.inputDigest,
    };
  expect(verifiedObservation(r, identity).outcome).toBe('PASS');
  for (const key of Object.keys(identity))
    expect(() => verifiedObservation(r, { ...identity, [key]: 'wrong' })).toThrow();
  r.observed.stdout.capturedBytes = 1048577;
  expect(() => verifiedObservation(r, identity)).toThrow();
});
it('preflights incompatible dependencies, configs and bounded source without installation', () => {
  const files = [
    { path: 'package.json', content: '{}' },
    { path: 'a.ts', content: 'export const a = 1;' },
  ];
  expect(compatibleFiles('typescript-typecheck-v1', files).compatible).toBe(true);
  files[0]!.content = '{"dependencies":{"evil":"1.0.0"}}';
  expect(compatibleFiles('typescript-typecheck-v1', files).compatible).toBe(false);
  expect(() =>
    compatibleFiles('typescript-typecheck-v1', [{ path: '../evil', content: '' }]),
  ).toThrow();
});
it('request data cannot inject authoritative execution controls or duplicate profiles', () => {
  for (const field of [
    'command',
    'image',
    'environment',
    'repositoryId',
    'organizationId',
    'network',
    'limits',
  ])
    expect(() =>
      ValidationRequestSchema.parse({ requestId: randomUUID(), [field]: 'evil' }),
    ).toThrow();
  expect(() =>
    ValidationRequestSchema.parse({
      requestId: randomUUID(),
      profiles: ['vitest-unit-v1', 'vitest-unit-v1'],
    }),
  ).toThrow();
});
