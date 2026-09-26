import { describe, expect, it, vi } from 'vitest';
import { ReviewVerdict } from '@codelens/database';
import { Role, Severity, type ReviewPolicy } from '@codelens/shared';
import { computeReviewGate, type GateInput } from './review-gate';
import { ReviewSessionsService } from './review-sessions.service';

const policy: ReviewPolicy = {
  minApprovals: 1, blockingSeverity: Severity.HIGH, riskScoreGate: 70,
  requireTestsForCodeChanges: false, sensitiveFlagsRequireTwoApprovals: false,
  autoPostGithubComment: false, blockOnSecretDetection: false,
  githubCommentMinRole: Role.REVIEWER, checklist: [], extraSemgrepRulesets: [],
  excludePatterns: [],
};

function gate(overrides: Partial<GateInput> = {}) {
  return computeReviewGate({
    policy, headSha: 'head-1', reviews: [], findings: [],
    resolvedFingerprints: new Set(), riskScore: null, metrics: null,
    analyzed: true, ...overrides,
  });
}

describe('review gate transitions', () => {
  const reviewer = { id: 'reviewer-1', name: 'Reviewer' };
  const review = { reviewerId: reviewer.id, reviewer, headSha: 'head-1' };

  it('counts only current-head approvals and blocks a changes request', () => {
    expect(gate({ reviews: [{ ...review, verdict: ReviewVerdict.APPROVED }] }).readyToMerge).toBe(true);
    expect(gate({ reviews: [{ ...review, headSha: 'old-head', verdict: ReviewVerdict.APPROVED }] })
      .currentApprovals).toBe(0);
    expect(gate({ reviews: [{ ...review, verdict: ReviewVerdict.CHANGES_REQUESTED }] })
      .blockingReasons).toEqual(expect.arrayContaining([expect.stringMatching(/Changes requested/)]));
  });

  it('clears a linked finding only when resolved and treats risk as advisory', () => {
    const finding = { severity: Severity.HIGH, analyzer: 'SEMGREP', fingerprint: 'finding-1', preexisting: false };
    const reviews = [{ ...review, verdict: ReviewVerdict.APPROVED }];
    expect(gate({ reviews, findings: [finding] }).readyToMerge).toBe(false);
    const ready = gate({ reviews, findings: [finding], resolvedFingerprints: new Set(['finding-1']), riskScore: 90 });
    expect(ready.readyToMerge).toBe(true);
    expect(ready.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Risk score 90/)]));
  });

  it('blocks when no current analysis has completed', () => {
    const result = gate({ analyzed: false, reviews: [{ ...review, verdict: ReviewVerdict.APPROVED }] });
    expect(result.readyToMerge).toBe(false);
    expect(result.blockingReasons).toEqual(expect.arrayContaining([expect.stringMatching(/not been analysed/)]));
  });

  it('does not feed stale run findings, metrics or risk into the current gate', async () => {
    const prisma = { unscoped: { review: { findMany: vi.fn().mockResolvedValue([]) },
      pullRequest: { findFirst: vi.fn().mockResolvedValue({
      id: 'pr-1', headSha: 'new-head', authorUserId: null,
      repository: { fullName: 'acme/payments' },
    }) } } };
    const report = { getLatest: vi.fn().mockResolvedValue({
      analyzed: true, run: { id: 'old-run', stale: true, status: 'COMPLETED' },
      findings: [{ severity: Severity.HIGH, analyzer: 'SEMGREP', fingerprint: 'old', preexisting: false }],
      risk: { score: 95 },
      metrics: { authFileChanged: true, paymentFileChanged: false,
        databaseFileChanged: false, infraFileChanged: false,
        testFilesChanged: 0, linesAdded: 30, linesDeleted: 0 },
      ragContext: [], toolRuns: [], degradation: [],
    }) };
    const service = new ReviewSessionsService(
      prisma as never, {} as never,
      { getPolicy: vi.fn().mockResolvedValue({ ...policy, sensitiveFlagsRequireTwoApprovals: true }) } as never,
      report as never,
      { listForPullRequest: vi.fn().mockResolvedValue([]), resolvedFingerprintsOf: vi.fn().mockReturnValue(new Set()) } as never,
      { list: vi.fn().mockResolvedValue([]) } as never,
    );
    const session = await service.getSession({ organizationId: 'org-1', pullRequestId: 'pr-1',
      userId: 'user-1', role: Role.REVIEWER });
    expect(session.gate.requiredApprovals).toBe(1);
    expect(session.gate.blockingReasons).toEqual(expect.arrayContaining([expect.stringMatching(/not been analysed/)]));
    expect(session.gate.blockingReasons.join(' ')).not.toMatch(/unresolved finding/);
    expect(session.gate.warnings.join(' ')).not.toMatch(/Risk score/);
  });
});
