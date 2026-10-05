import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  Role,
  ReviewVerdict as SharedReviewVerdict,
  ShareScope,
  SubmitReviewSchema,
  type ReviewGateStatus,
  type ReviewView,
  type SubmitReviewInput,
} from '@codelens/shared';
import { ReviewVerdict } from '@codelens/database';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit-logs/audit.service';
import { PolicyService } from '../organizations/policy.service';
import { AnalysisReportService } from '../analysis/analysis-report.service';
import { CommentsService } from '../comments/comments.service';
import { computeReviewGate, asSeverity } from './review-gate';
import { computePermissions, type ReviewPermissions } from './review-permissions';
import { ShareLinksService } from './share-links.service';

/**
 * The review workspace.
 *
 * There is no ReviewSession table and deliberately so. A "session" is a view: the pull request,
 * its authoritative `ReviewRun` (analysis state), its `Review` rows (human verdicts), its `Comment`
 * threads, and its `ShareLink`s. Adding a fourth table to represent the composition of three
 * existing ones would create a second place where review state lives, and the two would
 * disagree the first time a run was re-triggered. The session id is therefore the pull request
 * id, and every field is derived on read.
 *
 * What this service owns that nothing else does: assembling that view in one round trip, and
 * turning human verdicts into both a merge gate and ML training labels.
 */
@Injectable()
export class ReviewSessionsService {
  private readonly logger = new Logger(ReviewSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly report: AnalysisReportService,
    private readonly comments: CommentsService,
    private readonly shareLinks: ShareLinksService,
  ) {}

  /**
   * The full workspace payload.
   *
   * One request rather than eight. The review page needs the analysis, the verdicts, the
   * threads and the gate together to render anything useful, and fetching them separately makes
   * the page assemble itself visibly in stages — with the merge gate, the most decision-relevant
   * part, arriving last.
   */
  async getSession(params: {
    organizationId: string;
    pullRequestId: string;
    userId: string;
    role: Role;
  }) {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      // organizationId in the filter, always. A cuid is guessable enough that omitting it here
      // would make every pull request in every tenant readable.
      where: { id: params.pullRequestId, organizationId: params.organizationId },
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        state: true,
        draft: true,
        htmlUrl: true,
        authorLogin: true,
        authorAvatarUrl: true,
        authorUserId: true,
        headRef: true,
        headSha: true,
        baseRef: true,
        additions: true,
        deletions: true,
        changedFiles: true,
        commitCount: true,
        merged: true,
        mergedAt: true,
        labels: true,
        githubCreatedAt: true,
        githubUpdatedAt: true,
        latestRiskScore: true,
        latestRiskLevel: true,
        firstReviewedAt: true,
        repository: {
          select: {
            id: true,
            fullName: true,
            name: true,
            owner: true,
            private: true,
            defaultBranch: true,
            primaryLanguage: true,
            htmlUrl: true,
            indexStatus: true,
            indexedAt: true,
          },
        },
      },
    });

    if (!pullRequest) throw new NotFoundError('Review session', params.pullRequestId);

    const [analysis, reviews, commentThreads, shareLinks, policy] = await Promise.all([
      this.report.getLatest(params.organizationId, params.pullRequestId),
      this.listReviews(params.organizationId, params.pullRequestId, pullRequest.headSha),
      this.comments.listForPullRequest(params.organizationId, params.pullRequestId),
      this.shareLinks.list(params.organizationId, params.pullRequestId),
      this.policy.getPolicy(params.organizationId),
    ]);

    const permissions = computePermissions({
      role: params.role,
      userId: params.userId,
      pullRequestAuthorUserId: pullRequest.authorUserId,
      githubCommentMinRole: policy.githubCommentMinRole,
    });

    const analysisReady = analysis.analyzed && !analysis.run?.stale &&
      analysis.run?.status === 'COMPLETED';

    const gate = computeReviewGate({
      policy,
      headSha: pullRequest.headSha,
      reviews: reviews.map((review) => ({
        reviewerId: review.reviewer.id,
        reviewer: { id: review.reviewer.id, name: review.reviewer.name },
        verdict: review.verdict as ReviewVerdict,
        headSha: review.headSha,
      })),
      findings: (analysisReady ? analysis.findings : []).map((finding) => ({
        severity: asSeverity(finding.severity),
        analyzer: finding.analyzer,
        fingerprint: finding.fingerprint,
        preexisting: finding.preexisting,
      })),
      resolvedFingerprints: this.comments.resolvedFingerprintsOf(commentThreads),
      riskScore: analysisReady ? (analysis.risk?.score ?? null) : null,
      metrics: analysisReady ? analysis.metrics : null,
      analyzed: analysisReady,
    });

    return {
      // The session is the pull request. Stated in the payload so a client is never tempted to
      // look for a separate identifier.
      sessionId: pullRequest.id,
      pullRequestId: pullRequest.id,

      repository: pullRequest.repository,

      pullRequest: {
        id: pullRequest.id,
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body,
        state: pullRequest.state,
        draft: pullRequest.draft,
        htmlUrl: pullRequest.htmlUrl,
        author: {
          login: pullRequest.authorLogin,
          avatarUrl: pullRequest.authorAvatarUrl,
          userId: pullRequest.authorUserId,
        },
        headRef: pullRequest.headRef,
        headSha: pullRequest.headSha,
        baseRef: pullRequest.baseRef,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changedFiles: pullRequest.changedFiles,
        commitCount: pullRequest.commitCount,
        merged: pullRequest.merged,
        mergedAt: pullRequest.mergedAt?.toISOString() ?? null,
        labels: pullRequest.labels,
        githubCreatedAt: pullRequest.githubCreatedAt?.toISOString() ?? null,
        githubUpdatedAt: pullRequest.githubUpdatedAt?.toISOString() ?? null,
        firstReviewedAt: pullRequest.firstReviewedAt?.toISOString() ?? null,
      },

      // ---- analysis state: the authoritative ReviewRun and everything it produced
      analyzed: analysis.analyzed,
      run: analysis.run,
      risk: analysis.risk,
      findings: analysis.findings,
      aiReview: analysis.aiReview,
      // Lets the UI distinguish "the org turned this off" from "the provider failed", which are
      // a settings link and a re-run button respectively.
      aiReviewStatus: analysis.aiReviewStatus,
      summary: analysis.summary,
      metrics: analysis.metrics,

      // Chunk bodies are large and the workspace only needs to show what informed the review;
      // the full text is available from the dedicated rag-context endpoint.
      ragContext: summarizeRagContext(analysis.ragContext),

      // Per-tool provenance without the payloads, which are the audit spine rather than
      // something the review page renders.
      toolRuns: analysis.toolRuns.map((tool) => ({
        id: tool.id,
        tool: tool.tool,
        status: tool.status,
        sequence: tool.sequence,
        durationMs: tool.durationMs,
        cacheHit: tool.cacheHit,
        error: tool.error,
        costCents: tool.costCents,
        tokenUsage: tool.tokenUsage,
      })),

      // ---- human layer
      reviews,
      gate,
      comments: commentThreads,
      shareLinks,
      permissions,

      degradation: analysis.degradation,
    };
  }

  /**
   * Submit a verdict.
   *
   * Upserts on `(pullRequestId, reviewerId, headSha)`, which the schema already enforces as
   * unique. So changing your mind on the same commit revises your verdict rather than stacking
   * a second one, and a new commit needs a fresh verdict because the old one described code
   * that no longer exists.
   *
   * ReviewRun is not touched. A human verdict is not a property of a pipeline execution, and
   * writing one into the run would make the run's status mean two different things.
   */
  async submitVerdict(params: {
    organizationId: string;
    pullRequestId: string;
    userId: string;
    role: Role;
    verdict: ReviewVerdict;
    input: SubmitReviewInput;
    traceId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<{ review: ReviewView; gate: ReviewGateStatus }> {
    const input = SubmitReviewSchema.parse(params.input);
    const policy = await this.policy.getPolicy(params.organizationId);
    const { pullRequest, review } = await this.prisma.$transaction(async (db) => {
      // Serialize verdicts with authoritative head updates, including concurrent requests.
      await db.$queryRaw`SELECT id FROM "PullRequest" WHERE id=${params.pullRequestId} AND "organizationId"=${params.organizationId} FOR UPDATE`;
      const pullRequest = await db.pullRequest.findFirst({
        where: { id: params.pullRequestId, organizationId: params.organizationId },
        select: {
          id: true,
          number: true,
          headSha: true,
          authorUserId: true,
          merged: true,
          wasRisky: true,
          firstReviewedAt: true,
          githubCreatedAt: true,
          repository: { select: { fullName: true } },
        },
      });

      if (!pullRequest) throw new NotFoundError('Review session', params.pullRequestId);

      if (input.expectedHeadSha !== pullRequest.headSha) {
        throw new ConflictError(
          'The pull request changed after this review was loaded. Refresh the review before submitting a verdict.',
          { reason: 'HEAD_CHANGED' },
        );
      }

      const permissions = computePermissions({
        role: params.role,
        userId: params.userId,
        pullRequestAuthorUserId: pullRequest.authorUserId,
        githubCommentMinRole: policy.githubCommentMinRole,
      });

      // Enforced here, not only reported in the workspace payload. The permissions block is a
      // UI affordance; this is the authorization.
      if (params.verdict === ReviewVerdict.APPROVED && !permissions.canApprove) {
        throw new ForbiddenError(
          permissions.deniedReasons.canApprove ?? 'You may not approve this pull request.',
          { verdict: params.verdict, role: params.role },
        );
      }

      if (params.verdict !== ReviewVerdict.APPROVED && !permissions.canRequestChanges) {
        throw new ForbiddenError(
          permissions.deniedReasons.canRequestChanges ?? 'You may not submit a verdict.',
          { verdict: params.verdict, role: params.role },
        );
      }

      if (pullRequest.merged) {
        throw new ValidationError(
          'This pull request is already merged, so a verdict would have no effect. Comment on it ' +
            'instead if there is something worth recording.',
        );
      }

      const dismissedFingerprints = input.dismissedFindings.map((entry) => entry.fingerprint);

      const review = await db.review.upsert({
        where: {
          pullRequestId_reviewerId_headSha: {
            pullRequestId: pullRequest.id,
            reviewerId: params.userId,
            headSha: pullRequest.headSha,
          },
        },
        create: {
          organizationId: params.organizationId,
          pullRequestId: pullRequest.id,
          reviewerId: params.userId,
          verdict: params.verdict,
          summary: input.summary ?? null,
          headSha: pullRequest.headSha,
          acknowledgedChecklistItems: input.acknowledgedChecklistItems,
          dismissedFindingCount: dismissedFingerprints.length,
        },
        update: {
          verdict: params.verdict,
          summary: input.summary ?? null,
          acknowledgedChecklistItems: input.acknowledgedChecklistItems,
          dismissedFindingCount: dismissedFingerprints.length,
        },
        include: { reviewer: { select: { id: true, name: true, avatarUrl: true } } },
      });

      await this.audit.recordInTransaction(db, {
        organizationId: params.organizationId,
        action: AuditAction.REVIEW_SUBMITTED,
        actorId: params.userId,
        resourceType: 'Review',
        resourceId: review.id,
        description:
          `${verdictLabel(params.verdict)} ${pullRequest.repository.fullName}` +
          `#${pullRequest.number} at ${pullRequest.headSha.slice(0, 7)}` +
          (dismissedFingerprints.length > 0
            ? `, dismissing ${dismissedFingerprints.length} finding(s)`
            : ''),
        metadata: {
          pullRequestId: pullRequest.id,
          verdict: params.verdict,
          headSha: pullRequest.headSha,
          acknowledgedChecklistItems: input.acknowledgedChecklistItems,
          // Fingerprints and reasons, not the finding text. Dismissals are the signal the noise
          // filter learns from, so which rule was dismissed and why is the part worth keeping.
          dismissedFindings: input.dismissedFindings.map((entry) => ({
            fingerprint: entry.fingerprint,
            reason: entry.reason,
          })),
          hasSummary: Boolean(input.summary),
        },
        traceId: params.traceId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });
      return { pullRequest, review };
    });

    // Training feedback is noncritical and happens only after verdict and audit commit.
    await this.recordTrainingLabels({
      organizationId: params.organizationId,
      pullRequest,
      verdict: params.verdict,
    });

    const [reviews, analysis, threads] = await Promise.all([
      this.listReviews(params.organizationId, pullRequest.id, pullRequest.headSha),
      this.report.getLatest(params.organizationId, pullRequest.id),
      this.comments.listForPullRequest(params.organizationId, pullRequest.id),
    ]);

    const analysisReady = analysis.analyzed && !analysis.run?.stale &&
      analysis.run?.status === 'COMPLETED';

    const gate = computeReviewGate({
      policy,
      headSha: pullRequest.headSha,
      reviews: reviews.map((entry) => ({
        reviewerId: entry.reviewer.id,
        reviewer: { id: entry.reviewer.id, name: entry.reviewer.name },
        verdict: entry.verdict as ReviewVerdict,
        headSha: entry.headSha,
      })),
      findings: (analysisReady ? analysis.findings : []).map((finding) => ({
        severity: asSeverity(finding.severity),
        analyzer: finding.analyzer,
        fingerprint: finding.fingerprint,
        preexisting: finding.preexisting,
      })),
      resolvedFingerprints: this.comments.resolvedFingerprintsOf(threads),
      riskScore: analysisReady ? (analysis.risk?.score ?? null) : null,
      metrics: analysisReady ? analysis.metrics : null,
      analyzed: analysisReady,
    });

    return { review: toReviewView(review, pullRequest.headSha), gate };
  }

  /**
   * Feed the human verdict back into the ML training labels.
   *
   * This is the loop that makes the risk model improve rather than stay frozen at its bootstrap
   * weights. `PullRequest.wasRisky` is the classifier's target and `actualReviewMinutes` is the
   * regressor's, and a reviewer's verdict is the best ground truth either will ever get.
   *
   * The label is derived from the *whole* review history, not the verdict just submitted: once
   * anyone has requested changes, the change was risky, and a later approval of the fixed code
   * does not retroactively make the original safe. Flipping the label back on approval would
   * teach the model that problems found in review were never problems.
   *
   * Writes only to PullRequest, never to ReviewRun.
   */
  private async recordTrainingLabels(params: {
    organizationId: string;
    pullRequest: {
      id: string;
      wasRisky: boolean | null;
      firstReviewedAt: Date | null;
      githubCreatedAt: Date | null;
    };
    verdict: ReviewVerdict;
  }): Promise<void> {
    try {
      const everRequestedChanges = await this.prisma.unscoped.review.count({
        where: {
          pullRequestId: params.pullRequest.id,
          organizationId: params.organizationId,
          verdict: ReviewVerdict.CHANGES_REQUESTED,
        },
      });

      // The Review row is revised in place. AuditLog is the durable record of earlier
      // changes requests after that reviewer later approves the same head.
      const earlierChangeRequest = params.pullRequest.wasRisky === true || everRequestedChanges > 0
        ? null
        : await this.prisma.unscoped.auditLog.findFirst({
            where: {
              organizationId: params.organizationId,
              action: AuditAction.REVIEW_SUBMITTED,
              AND: [
                { metadata: { path: ['pullRequestId'], equals: params.pullRequest.id } },
                { metadata: { path: ['verdict'], equals: ReviewVerdict.CHANGES_REQUESTED } },
              ],
            },
            select: { id: true },
          });
      const wasRisky = params.pullRequest.wasRisky === true ||
        everRequestedChanges > 0 || earlierChangeRequest !== null;
      const now = new Date();

      // Time-to-first-review, measured once. Re-measuring on every later verdict would record
      // the time to the *last* review instead, which is a different quantity and would corrupt
      // the regression target.
      const firstReviewedAt = params.pullRequest.firstReviewedAt ?? now;

      const actualReviewMinutes =
        params.pullRequest.githubCreatedAt === null
          ? null
          : Math.max(
              1,
              Math.round(
                (firstReviewedAt.getTime() - params.pullRequest.githubCreatedAt.getTime()) / 60_000,
              ),
            );

      await this.prisma.unscoped.pullRequest.update({
        where: { id: params.pullRequest.id },
        data: {
          firstReviewedAt,
          ...(actualReviewMinutes === null ? {} : { actualReviewMinutes }),
          wasRisky,
          riskLabelReason: wasRisky
            ? 'A reviewer requested changes on this pull request'
            : 'Approved with no changes requested',
        },
      });
    } catch (error) {
      // A verdict is user-visible work that succeeded; losing a training label is a degradation
      // of future model quality, not a reason to fail the request the reviewer just made.
      this.logger.error(
        `Could not record training labels for pull request ${params.pullRequest.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Verdicts for a pull request, newest first, with staleness against the current head. */
  async listReviews(
    organizationId: string,
    pullRequestId: string,
    headSha: string,
  ): Promise<ReviewView[]> {
    const rows = await this.prisma.unscoped.review.findMany({
      where: { pullRequestId, organizationId },
      include: { reviewer: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => toReviewView(row, headSha));
  }

  /**
   * Safe projection for an unauthenticated share link.
   *
   * Built as an explicit allowlist rather than by deleting fields from the workspace payload.
   * A denylist fails silently the moment a new field is added upstream — the field simply
   * starts leaking — whereas an allowlist fails by omitting something, which someone notices
   * and fixes. Given this is the one endpoint that serves tenant data with no authenticated
   * actor, that asymmetry decides it.
   *
   * Excluded on purpose: every `ToolRun` output (raw provider and analyzer payloads), audit
   * entries, share links, permissions, reviewer email addresses, internal ids that would let a
   * viewer probe other endpoints, and the diff snippets and retrieved source when `redactCode`
   * is set.
   */
  async getSharedSession(params: {
    organizationId: string;
    pullRequestId: string;
    scope: ShareScope;
    redactCode: boolean;
    expiresAt: Date;
  }) {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: params.pullRequestId, organizationId: params.organizationId },
      select: {
        number: true,
        title: true,
        state: true,
        htmlUrl: true,
        authorLogin: true,
        headSha: true,
        baseRef: true,
        additions: true,
        deletions: true,
        changedFiles: true,
        commitCount: true,
        githubCreatedAt: true,
        repository: { select: { fullName: true } },
      },
    });

    if (!pullRequest) throw new NotFoundError('Share link');

    const [analysis, policy, reviews] = await Promise.all([
      this.report.getLatest(params.organizationId, params.pullRequestId),
      this.policy.getPolicy(params.organizationId),
      this.prisma.unscoped.review.findMany({
        where: { pullRequestId: params.pullRequestId, organizationId: params.organizationId },
        // Names only. An external viewer has no business learning internal email addresses,
        // and the user id would be a handle for probing other endpoints.
        select: { verdict: true, headSha: true, createdAt: true, reviewer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const full = params.scope === ShareScope.FULL;

    const severityCounts = analysis.findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
      return counts;
    }, {});

    const currentReviews = reviews.filter((review) => review.headSha === pullRequest.headSha);

    return {
      shared: true,
      scope: params.scope,
      redactCode: params.redactCode,
      expiresAt: params.expiresAt.toISOString(),

      repository: { fullName: pullRequest.repository.fullName },

      pullRequest: {
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        htmlUrl: pullRequest.htmlUrl,
        authorLogin: pullRequest.authorLogin,
        headSha: pullRequest.headSha,
        baseRef: pullRequest.baseRef,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changedFiles: pullRequest.changedFiles,
        commitCount: pullRequest.commitCount,
        createdAt: pullRequest.githubCreatedAt?.toISOString() ?? null,
      },

      analyzed: analysis.analyzed,

      // Timing and capability flags, without run ids, trigger identity, cost or token counts.
      // What a viewer needs is whether the analysis was complete, not what it cost to produce.
      run: analysis.run
        ? {
            status: analysis.run.status,
            stale: analysis.run.stale,
            finishedAt: analysis.run.finishedAt,
            capabilities: analysis.run.capabilities,
          }
        : null,

      risk: analysis.risk
        ? {
            score: analysis.risk.score,
            level: analysis.risk.level,
            confidence: analysis.risk.confidence,
            // Attributions are the explanation of the score, so a shared review without them
            // is just a number the recipient has to take on faith.
            reasons: analysis.risk.reasons,
            predictedReviewTimeMinutes: analysis.risk.predictedReviewTimeMinutes,
            isBaseline: analysis.risk.isBaseline,
            modelName: analysis.risk.modelName,
          }
        : null,

      summary: analysis.summary,

      findingSummary: {
        total: analysis.findings.length,
        new: analysis.findings.filter((finding) => !finding.preexisting).length,
        bySeverity: severityCounts,
        blockingSeverity: policy.blockingSeverity,
      },

      findings: full
        ? analysis.findings.map((finding) => ({
            analyzer: finding.analyzer,
            ruleId: finding.ruleId,
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            path: finding.path,
            line: finding.line,
            helpUrl: finding.helpUrl,
            preexisting: finding.preexisting,
            // The snippet is a verbatim line of the customer's source.
            snippet: params.redactCode ? null : finding.snippet,
          }))
        : [],

      aiReview:
        analysis.aiReview && full
          ? {
              executiveSummary: analysis.aiReview.executiveSummary,
              technicalSummary: analysis.aiReview.technicalSummary,
              beginnerExplanation: analysis.aiReview.beginnerExplanation,
              recommendationRationale: analysis.aiReview.recommendationRationale,
              effectiveRecommendation: analysis.aiReview.effectiveRecommendation,
              confidence: analysis.aiReview.confidence,
              fileExplanations: analysis.aiReview.fileExplanations,
              missingTests: analysis.aiReview.missingTests,
              openQuestions: analysis.aiReview.openQuestions,
              reviewerChecklist: analysis.aiReview.reviewerChecklist,
            }
          : analysis.aiReview
            ? { executiveSummary: analysis.aiReview.executiveSummary }
            : null,

      metrics: analysis.metrics,

      // Paths and symbols, never chunk bodies: those are verbatim source from files the change
      // did not even touch, which is the last thing to hand to an external viewer.
      ragContext: full
        ? {
            chunkCount: analysis.ragContext.length,
            files: [...new Set(analysis.ragContext.map((chunk) => chunk.path))].slice(0, 50),
          }
        : null,

      verdicts: {
        approvals: currentReviews.filter((r) => r.verdict === ReviewVerdict.APPROVED).length,
        changesRequested: currentReviews.filter(
          (r) => r.verdict === ReviewVerdict.CHANGES_REQUESTED,
        ).length,
        needsDiscussion: currentReviews.filter(
          (r) => r.verdict === ReviewVerdict.NEEDS_DISCUSSION,
        ).length,
        reviewers: currentReviews.map((review) => ({
          name: review.reviewer.name,
          verdict: review.verdict,
          at: review.createdAt.toISOString(),
        })),
      },

      degradation: analysis.degradation,
    };
  }
}

function verdictLabel(verdict: ReviewVerdict): string {
  switch (verdict) {
    case ReviewVerdict.APPROVED:
      return 'Approved';
    case ReviewVerdict.CHANGES_REQUESTED:
      return 'Requested changes on';
    default:
      return 'Flagged for discussion';
  }
}

function toReviewView(
  row: {
    id: string;
    pullRequestId: string;
    reviewer: { id: string; name: string; avatarUrl: string | null };
    verdict: ReviewVerdict;
    summary: string | null;
    headSha: string;
    acknowledgedChecklistItems: string[];
    dismissedFindingCount: number;
    createdAt: Date;
    updatedAt: Date;
  },
  currentHeadSha: string,
): ReviewView {
  return {
    id: row.id,
    pullRequestId: row.pullRequestId,
    reviewer: row.reviewer,
    verdict: row.verdict as SharedReviewVerdict,
    summary: row.summary,
    headSha: row.headSha,
    // Not stored: derived from the current head every time it is read, so a new commit
    // invalidates every outstanding approval without a migration or a background job.
    stale: row.headSha !== currentHeadSha,
    acknowledgedChecklistItems: row.acknowledgedChecklistItems,
    dismissedFindingCount: row.dismissedFindingCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Group retrieved context by file without carrying the chunk bodies. */
function summarizeRagContext(
  chunks: Array<{
    forFilePath: string | null;
    path: string;
    symbol: string | null;
    kind: string;
    tokenCount: number;
    score: number;
    sources: string[];
    rationale: string | null;
  }>,
) {
  return {
    chunkCount: chunks.length,
    totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
    repositoryOverviewCount: chunks.filter((chunk) => chunk.forFilePath === null).length,
    chunks: chunks.map((chunk) => ({
      forFilePath: chunk.forFilePath,
      path: chunk.path,
      symbol: chunk.symbol,
      kind: chunk.kind,
      tokenCount: chunk.tokenCount,
      score: chunk.score,
      sources: chunk.sources,
      rationale: chunk.rationale,
    })),
  };
}
