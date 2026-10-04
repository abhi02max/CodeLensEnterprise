import { materializeCandidate } from '@codelens/patch-core';
import { type ExactSnapshot } from '@codelens/github/dist/exact-git-snapshot';
import {
  checkCompatibility,
  ResultSchema,
  validateInput,
  hash,
  type ValidationResult,
} from '@codelens/validation-executor';
import { type ValidationOutcome, type ValidationStepView } from '@codelens/shared';
import {
  reconstructApplication,
  verifyApplicationManifest,
  type StoredApplicationProposal,
} from './patch-application-content';

export function reconstructValidation(
  original: ExactSnapshot,
  patched: ExactSnapshot,
  proposal: StoredApplicationProposal,
  binding: { headSha: string; snapshotDigest: string; candidateDigest: string },
  manifest: unknown,
) {
  if (
    original.revision !== binding.headSha ||
    patched.revision !== binding.headSha ||
    original.digest !== binding.snapshotDigest ||
    patched.digest !== binding.snapshotDigest ||
    original.repository !== patched.repository
  )
    throw new Error('SNAPSHOT_BINDING_REJECTED');
  // Independently verify original bytes and the independently fetched patched source.
  const first = reconstructApplication(original, proposal);
  const second = reconstructApplication(patched, proposal);
  verifyApplicationManifest(first.expected, manifest);
  verifyApplicationManifest(second.expected, manifest);
  if (second.expected.digest !== binding.candidateDigest)
    throw new Error('CANDIDATE_BINDING_REJECTED');
  const candidate = materializeCandidate(second.payload);
  return {
    ORIGINAL: materializeCandidate(first.payload).originals.map(({ path, content }) => ({
      path,
      content,
    })),
    PATCHED: candidate.candidates.map(({ path, content }) => ({ path, content })),
  };
}
export function stepOutcome(raw: unknown): ValidationStepView['outcome'] {
  const r = ResultSchema.parse(raw);
  if (r.status === 'UNSUPPORTED' && !r.observed.started && r.observed.cleanup === 'DISPOSED')
    return 'UNSUPPORTED';
  if (
    r.status !== 'VALIDATION_EXECUTED' ||
    !r.observed.started ||
    r.observed.cleanup !== 'DISPOSED' ||
    r.observed.termination !== 'EXITED' ||
    r.observed.oom ||
    r.runnerReported.status !== 'VALID' ||
    !r.runnerReported.report ||
    (r.profile === 'vitest-unit-v1' && r.runnerReported.report.kind !== 'tests') ||
    (r.profile === 'typescript-typecheck-v1' && r.runnerReported.report.kind !== 'typecheck')
  )
    return 'INCONCLUSIVE';
  if (
    r.observed.exitCode === 0 &&
    r.runnerReported.report.failed === 0 &&
    r.runnerReported.report.total > 0
  )
    return 'PASS';
  if (r.observed.exitCode === 1 && r.runnerReported.report.failed > 0) return 'FAIL';
  return 'INCONCLUSIVE';
}
export function compareSteps(original?: string, patched?: string): ValidationOutcome {
  if (original === 'UNSUPPORTED' || patched === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (!['PASS', 'FAIL'].includes(original ?? '') || !['PASS', 'FAIL'].includes(patched ?? ''))
    return 'INCONCLUSIVE';
  if (original === patched) return original === 'PASS' ? 'BOTH_PASS' : 'BOTH_FAIL';
  return original === 'PASS' ? 'ORIGINAL_PASS_PATCHED_FAIL' : 'ORIGINAL_FAIL_PATCHED_PASS';
}
export function aggregateComparisons(values: ValidationOutcome[]): ValidationOutcome {
  if (values.every((v) => v === 'BOTH_PASS')) return 'BOTH_PASS';
  if (values.every((v) => v === 'UNSUPPORTED')) return 'UNSUPPORTED';
  const different = values.filter((v) => v !== 'BOTH_PASS');
  return new Set(different).size === 1 ? different[0]! : 'INCONCLUSIVE';
}
export function verifiedObservation(
  raw: unknown,
  identity: {
    profile: string;
    image: string;
    bundleDigest: string;
    configurationDigest: string;
    nonce: string;
    inputDigest: string;
  },
) {
  const r = ResultSchema.parse(raw);
  if (
    r.profile !== identity.profile ||
    r.image !== identity.image ||
    r.bundleDigest !== identity.bundleDigest ||
    r.configurationDigest !== identity.configurationDigest ||
    r.correlation !== identity.nonce ||
    r.inputDigest !== identity.inputDigest
  )
    throw new Error('VALIDATION_RESULT_BINDING_REJECTED');
  for (const stream of [r.observed.stdout, r.observed.stderr]) {
    if (
      stream.capturedBytes > 1048576 ||
      Buffer.byteLength(stream.excerpt) > 8192 ||
      !/^[a-f0-9]{64}$/.test(stream.digest)
    )
      throw new Error('VALIDATION_OUTPUT_BOUND');
  }
  if (Buffer.byteLength(JSON.stringify(r)) > 65536) throw new Error('VALIDATION_RESULT_BOUND');
  return { result: r, outcome: stepOutcome(r), resultDigest: hash(JSON.stringify(r)) };
}
export function compatibleFiles(
  profile: 'typescript-typecheck-v1' | 'vitest-unit-v1',
  files: Array<{ path: string; content: string }>,
) {
  const normalized = validateInput({ version: 1, profile, files });
  try {
    checkCompatibility(normalized.input);
  } catch {
    return { ...normalized, compatible: false };
  }
  return { ...normalized, compatible: true };
}
export type PairedSources = ReturnType<typeof reconstructValidation>;
export type BrokerObservation = ValidationResult;
