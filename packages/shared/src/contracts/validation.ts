import { z } from 'zod';

export const VALIDATION_PROFILES = ['typescript-typecheck-v1', 'vitest-unit-v1'] as const;
export const ValidationProfileSchema = z.enum(VALIDATION_PROFILES);
export const ValidationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    profiles: z
      .array(ValidationProfileSchema)
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length)
      .default([...VALIDATION_PROFILES]),
  })
  .strict();
export const ValidationCancelSchema = z.object({ requestId: z.string().uuid() }).strict();
export const ValidationStateSchema = z.enum([
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const ValidationOutcomeSchema = z.enum([
  'BOTH_PASS',
  'ORIGINAL_PASS_PATCHED_FAIL',
  'ORIGINAL_FAIL_PATCHED_PASS',
  'BOTH_FAIL',
  'UNSUPPORTED',
  'INCONCLUSIVE',
]);
export const VALIDATION_LIMITATIONS =
  'Passing these checks does not establish that the proposal is safe. Runner reports are untrusted; comparisons do not establish causality. No repository changes or AI re-review are performed.';
export type ValidationRequest = z.infer<typeof ValidationRequestSchema>;
export type ValidationOutcome = z.infer<typeof ValidationOutcomeSchema>;
export interface ValidationStepView {
  id: string;
  profile: (typeof VALIDATION_PROFILES)[number];
  profileVersion: number;
  side: 'ORIGINAL' | 'PATCHED';
  inputDigest: string;
  resultDigest: string;
  outcome: 'PASS' | 'FAIL' | 'UNSUPPORTED' | 'INCONCLUSIVE';
  status: string;
  observed: {
    started: boolean;
    exitCode: number | null;
    termination: string;
    oom: boolean;
    durationMs: number;
    cleanup: 'DISPOSED' | 'UNCERTAIN';
    stdout: { excerpt: string; digest: string; capturedBytes: number; complete: boolean };
    stderr: { excerpt: string; digest: string; capturedBytes: number; complete: boolean };
  };
  runnerReported: {
    trusted: false;
    status: string;
    reportDigest: string | null;
    report: {
      version: 1;
      kind: 'typecheck' | 'tests';
      passed: number;
      failed: number;
      total: number;
    } | null;
  };
  startedAt: string;
  completedAt: string;
}
export interface ValidationView {
  id: string;
  applicationId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  headSha: string;
  snapshotDigest: string;
  candidateDigest: string;
  image: string;
  bundleDigest: string;
  configurationDigest: string;
  profiles: Array<(typeof VALIDATION_PROFILES)[number]>;
  state: z.infer<typeof ValidationStateSchema>;
  outcome: ValidationOutcome | null;
  cleanup: 'NOT_STARTED' | 'DISPOSED' | 'UNCERTAIN';
  failureCategory: string | null;
  stale: boolean;
  limitations: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  completedAt: string | null;
  steps: ValidationStepView[];
  comparisons: Array<{ profile: (typeof VALIDATION_PROFILES)[number]; outcome: ValidationOutcome }>;
}
