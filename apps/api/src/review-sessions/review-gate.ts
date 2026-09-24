import {
  Severity,
  severityAtLeast,
  type ReviewGateStatus,
  type ReviewPolicy,
} from '@codelens/shared';
import { ReviewVerdict } from '@codelens/database';

export interface GateInput {
  policy: ReviewPolicy;
  headSha: string;
  reviews: Array<{
    reviewerId: string;
    reviewer: { id: string; name: string };
    verdict: ReviewVerdict;
    headSha: string;
  }>;
  findings: Array<{ severity: Severity; analyzer: string; fingerprint: string; preexisting: boolean }>;
  /** Fingerprints whose comment thread has been resolved. */
  resolvedFingerprints: Set<string>;
  riskScore: number | null;
  metrics: {
    testFilesChanged: number;
    linesAdded: number;
    linesDeleted: number;
    authFileChanged: boolean;
    paymentFileChanged: boolean;
    databaseFileChanged: boolean;
    infraFileChanged: boolean;
  } | null;
  analyzed: boolean;
}

/**
 * Merge readiness under the organization's policy.
 *
 * The distinction between `blockingReasons` and `warnings` is the whole point, and it follows
 * what each policy field actually says it does. `minApprovals`, `blockingSeverity`,
 * `requireTestsForCodeChanges` and `blockOnSecretDetection` are stated as requirements, so they
 * block. `riskScoreGate` is documented as surfacing a "needs senior review" banner, so it
 * warns — a probabilistic model should not be able to veto a merge on its own, and a gate that
 * blocks on a score people cannot argue with is a gate they will route around.
 *
 * Nothing here writes anything. The gate is derived on read from reviews, findings and policy,
 * so changing the policy immediately changes the verdict on every open pull request instead of
 * leaving stale computed state behind.
 */
export function computeReviewGate(input: GateInput): ReviewGateStatus {
  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  // Verdicts against an older commit describe code that has since changed, so they are
  // excluded from the count entirely rather than carried forward.
  const current = input.reviews.filter((review) => review.headSha === input.headSha);
  const stale = input.reviews.filter((review) => review.headSha !== input.headSha);

  // Distinct reviewers, not rows: the unique constraint is per head SHA, so one person who
  // approved twice across two commits must not count as two approvals.
  const approvers = new Map<string, { id: string; name: string }>();
  const changeRequesters = new Map<string, { id: string; name: string }>();
  const discussionRequesters = new Map<string, { id: string; name: string }>();

  for (const review of current) {
    const target =
      review.verdict === ReviewVerdict.APPROVED
        ? approvers
        : review.verdict === ReviewVerdict.CHANGES_REQUESTED
          ? changeRequesters
          : discussionRequesters;

    target.set(review.reviewerId, review.reviewer);
  }

  // ---- approvals
  const touchesSensitiveArea = Boolean(
    input.metrics &&
      (input.metrics.authFileChanged ||
        input.metrics.paymentFileChanged ||
        input.metrics.databaseFileChanged ||
        input.metrics.infraFileChanged),
  );

  const requiredApprovals =
    input.policy.sensitiveFlagsRequireTwoApprovals && touchesSensitiveArea
      ? Math.max(2, input.policy.minApprovals)
      : input.policy.minApprovals;

  if (approvers.size < requiredApprovals) {
    blockingReasons.push(
      `${approvers.size} of ${requiredApprovals} required approval(s)` +
        (requiredApprovals > input.policy.minApprovals
          ? ' (raised because this change touches auth, payment, database or infrastructure code)'
          : ''),
    );
  }

  // ---- explicit objections
  if (changeRequesters.size > 0) {
    blockingReasons.push(
      `Changes requested by ${[...changeRequesters.values()].map((r) => r.name).join(', ')}`,
    );
  }

  if (discussionRequesters.size > 0) {
    warnings.push(
      `${[...discussionRequesters.values()].map((r) => r.name).join(', ')} marked this as ` +
        `needing discussion`,
    );
  }

  if (stale.length > 0) {
    warnings.push(
      `${stale.length} earlier verdict(s) apply to a previous commit and no longer count. ` +
        `They need to be re-submitted against the current head.`,
    );
  }

  // ---- findings
  if (!input.analyzed) {
    blockingReasons.push('This pull request has not been analysed yet.');
  }

  const newFindings = input.findings.filter((finding) => !finding.preexisting);

  const unresolvedBlocking = newFindings.filter(
    (finding) =>
      severityAtLeast(finding.severity, input.policy.blockingSeverity) &&
      !input.resolvedFingerprints.has(finding.fingerprint),
  );

  if (unresolvedBlocking.length > 0) {
    blockingReasons.push(
      `${unresolvedBlocking.length} unresolved finding(s) at or above ` +
        `${input.policy.blockingSeverity}. Resolve the comment thread on each, or dismiss it ` +
        `with a reason.`,
    );
  }

  // Counted separately from the severity rule: a committed credential is not a code-quality
  // finding that can be argued down, and the policy gives it its own switch.
  if (input.policy.blockOnSecretDetection) {
    const secrets = newFindings.filter((finding) => finding.analyzer === 'SECRET_SCAN');

    if (secrets.length > 0) {
      blockingReasons.push(
        `${secrets.length} possible secret(s) detected in the diff. Rotate the credential and ` +
          `remove it from the branch history.`,
      );
    }
  }

  // ---- tests
  if (input.policy.requireTestsForCodeChanges && input.metrics) {
    const changedLines = input.metrics.linesAdded + input.metrics.linesDeleted;

    // A threshold rather than any change at all: requiring a test for a one-line typo fix is
    // the kind of rule teams disable wholesale.
    if (input.metrics.testFilesChanged === 0 && changedLines >= 20) {
      blockingReasons.push(
        `No test file changed while ${changedLines} lines of code did. This organization ` +
          `requires tests for non-trivial changes.`,
      );
    }
  }

  // ---- risk, advisory by design
  if (input.riskScore !== null && input.riskScore >= input.policy.riskScoreGate) {
    warnings.push(
      `Risk score ${input.riskScore} is at or above this organization's gate of ` +
        `${input.policy.riskScoreGate}. Consider a second reviewer familiar with this area.`,
    );
  }

  return {
    readyToMerge: blockingReasons.length === 0,
    requiredApprovals,
    currentApprovals: approvers.size,
    blockingReasons,
    warnings,
    changesRequestedBy: [...changeRequesters.values()],
  };
}

/** Severity values, for narrowing Prisma's enum to the shared one. */
export function asSeverity(value: string): Severity {
  return value as Severity;
}
