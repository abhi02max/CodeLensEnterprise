import { Injectable } from '@nestjs/common';
import {
  REVIEW_STAGE_ORDER,
  ReviewStage,
  reviewRunProgress,
  type AiFinding,
  type ApprovalRecommendation,
  type ChecklistItem,
  type FileExplanation,
  type RiskReason,
  type SuggestedTestCase,
} from '@codelens/shared';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

/** The AI review tool's outcome, in the form the UI needs to decide what to offer. */
export interface AiReviewStatus {
  state: 'GENERATED' | 'SKIPPED' | 'FAILED' | 'NOT_RUN';
  /** Reviewer-facing explanation. Already sanitized upstream; never a provider payload. */
  reason: string | null;
  /**
   * True when re-running the analysis could plausibly produce a review. False for a
   * configuration problem — a rejected API key, a diff past the model's context window — where
   * re-running just fails again.
   */
  retryable: boolean;
}

/**
 * Failure codes the tool registry prefixes onto `ToolRun.error`, mapped to whether a re-run is
 * worth offering. Kept in step with `classifyAiFailure` in `@codelens/ai-agent`.
 */
const RETRYABLE_AI_FAILURE_HINTS = /TIMED_OUT|RATE_LIMITED|PROVIDER_UNAVAILABLE|did not respond|rate-limited|server error/i;

interface ToolRunSummary {
  tool: string;
  status: string;
  error: string | null;
  output: unknown;
}

/**
 * Read the AI tool's own account of what happened.
 *
 * Three distinct outcomes hide behind "no AI review", and the previous single fallback sentence
 * conflated them: the tool ran and deliberately skipped (no key, policy opt-out, secrets in the
 * diff), the tool ran and failed (provider or schema), or the tool never ran at all because an
 * upstream dependency died. Each one needs a different response from whoever is reading.
 */
function describeAiStatus(toolRuns: readonly ToolRunSummary[]): AiReviewStatus {
  const run = toolRuns.find((tool) => tool.tool === 'generate_ai_review');

  if (!run) {
    return {
      state: 'NOT_RUN',
      reason:
        'The AI review stage did not run, because an earlier stage it depends on did not ' +
        'complete.',
      retryable: true,
    };
  }

  if (run.status === 'SUCCESS') {
    const skippedReason =
      run.output && typeof run.output === 'object' && !Array.isArray(run.output)
        ? (run.output as Record<string, unknown>).skippedReason
        : undefined;

    return {
      state: 'SKIPPED',
      reason:
        typeof skippedReason === 'string'
          ? skippedReason
          : 'The AI review stage completed without producing a review.',
      // A deliberate skip is a configuration decision, so re-running changes nothing.
      retryable: false,
    };
  }

  // `ToolRun.error` is `<CODE>: <message>`. The code is for operators; the message was written
  // for the reviewer by classifyAiFailure, so only the message is surfaced.
  const raw = run.error ?? '';
  const message = raw.includes(': ') ? raw.slice(raw.indexOf(': ') + 2) : raw;

  return {
    state: 'FAILED',
    reason:
      message ||
      'The AI review could not be generated. Other analysis results are reported separately.',
    retryable: RETRYABLE_AI_FAILURE_HINTS.test(raw),
  };
}

/** The degradation note for a missing AI review: the stored reason, not a generic sentence. */
function describeAiGap(toolRuns: readonly ToolRunSummary[]): string {
  return (
    describeAiStatus(toolRuns).reason ??
    'The AI review could not be generated. Other analysis results are reported separately.'
  );
}

/**
 * Assembles the complete analysis payload for a pull request.
 *
 * This is the shape the review workspace renders from, and it is deliberately one request: the
 * UI needs risk, findings, context and the AI review together, and four round trips would make
 * the page assemble itself visibly in stages.
 *
 * Every section is independently nullable. A run that lost the ML service returns
 * `risk: null` with a reason rather than omitting the field, so the UI can explain the gap
 * instead of silently rendering an incomplete review as if it were whole.
 */
@Injectable()
export class AnalysisReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getLatest(organizationId: string, pullRequestId: string) {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: pullRequestId, organizationId },
      select: {
        id: true,
        number: true,
        title: true,
        headSha: true,
        repository: { select: { id: true, fullName: true } },
      },
    });

    if (!pullRequest) throw new NotFoundError('Pull request', pullRequestId);

    const run = await this.prisma.unscoped.reviewRun.findFirst({
      where: { pullRequestId, organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        toolRuns: { orderBy: { sequence: 'asc' } },
        findings: { orderBy: [{ severity: 'desc' }, { path: 'asc' }, { line: 'asc' }] },
        metrics: true,
        mlPrediction: true,
        aiReview: true,
        retrievedChunks: { orderBy: [{ forFilePath: 'asc' }, { rank: 'asc' }] },
        triggeredBy: { select: { id: true, name: true } },
      },
    });

    if (!run) {
      return {
        pullRequestId,
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          headSha: pullRequest.headSha,
          repositoryFullName: pullRequest.repository.fullName,
        },
        analyzed: false,
        run: null,
        risk: null,
        summary: null,
        aiReviewStatus: {
          state: 'NOT_RUN',
          reason: 'This pull request has not been analysed yet.',
          retryable: true,
        } satisfies AiReviewStatus,
        findings: [],
        ragContext: [],
        aiReview: null,
        toolRuns: [],
        metrics: null,
        degradation: ['This pull request has not been analysed yet.'],
      };
    }

    // A run against a previous head describes code that has since changed.
    const stale = run.headSha !== pullRequest.headSha;

    const degradation: string[] = [];
    if (stale) {
      degradation.push(
        `This analysis ran against commit ${run.headSha.slice(0, 7)} but the pull request head ` +
          `is now ${pullRequest.headSha.slice(0, 7)}. Re-run the analysis for current results.`,
      );
    }
    if (!run.hadStaticAnalysis) {
      degradation.push('Static analysis did not complete for this run.');
    }
    if (!run.hadMlRisk) {
      degradation.push(
        run.mlPrediction?.degradedReason ??
          'The ML service was unavailable, so this run has no risk score.',
      );
    }
    if (!run.hadRagContext) {
      degradation.push(
        'Repository context was unavailable. Index the repository for reviews that account ' +
          'for existing conventions.',
      );
    }
    if (!run.hadAiReview) {
      degradation.push(describeAiGap(run.toolRuns));
    }

    const prediction = run.mlPrediction;
    const ai = run.aiReview;

    return {
      pullRequestId,
      pullRequest: {
        number: pullRequest.number,
        title: pullRequest.title,
        headSha: pullRequest.headSha,
        repositoryFullName: pullRequest.repository.fullName,
      },
      analyzed: true,
      run: {
        id: run.id,
        status: run.status,
        stage: run.stage,
        progress: reviewRunProgress(run.stage as ReviewStage, REVIEW_STAGE_ORDER),
        trigger: run.trigger,
        triggeredBy: run.triggeredBy,
        headSha: run.headSha,
        stale,
        error: run.error,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        durationMs: run.durationMs,
        promptVersion: run.promptVersion,
        featureSchemaVersion: run.featureSchemaVersion,
        tokenUsage: {
          prompt: run.promptTokens,
          completion: run.completionTokens,
          total: run.promptTokens + run.completionTokens,
        },
        costCents: run.costCents,
        capabilities: {
          staticAnalysis: run.hadStaticAnalysis,
          mlRisk: run.hadMlRisk,
          ragContext: run.hadRagContext,
          aiReview: run.hadAiReview,
        },
      },

      // ---- risk
      risk: prediction
        ? {
            score: prediction.riskScore,
            level: prediction.riskLevel,
            probability: prediction.probability,
            confidence: prediction.confidence,
            isBaseline: prediction.isBaseline,
            reasons: (prediction.topRiskReasons ?? []) as unknown as RiskReason[],
            predictedReviewTimeMinutes: prediction.predictedReviewTimeMinutes,
            reviewTimeRange:
              prediction.reviewTimeLowerMinutes !== null &&
              prediction.reviewTimeUpperMinutes !== null
                ? {
                    lower: prediction.reviewTimeLowerMinutes,
                    upper: prediction.reviewTimeUpperMinutes,
                  }
                : null,
            similarPullRequests: (prediction.similarPullRequests ?? []) as unknown as unknown[],
            issueClusters: (prediction.issueClusters ?? []) as unknown as unknown[],
            modelName: prediction.modelName,
            modelVersion: prediction.modelVersion,
            status: prediction.status,
            degradedReason: prediction.degradedReason,
          }
        : null,

      // ---- narrative summary, preferring the AI executive summary
      summary: ai?.executiveSummary ?? null,

      /**
       * Why there is no AI review, when there isn't one.
       *
       * Separate from `degradation` because the client needs to branch on it: a review skipped
       * because the organization disabled external model calls is a settings link, whereas a
       * provider outage is a "re-run" button. One undifferentiated sentence forced the UI to
       * treat both the same.
       */
      aiReviewStatus: ai
        ? ({ state: 'GENERATED', reason: null, retryable: false } satisfies AiReviewStatus)
        : describeAiStatus(run.toolRuns),

      // ---- deterministic findings
      findings: run.findings.map((finding) => ({
        id: finding.id,
        analyzer: finding.analyzer,
        ruleId: finding.ruleId,
        severity: finding.severity,
        category: finding.category,
        message: finding.message,
        path: finding.path,
        line: finding.line,
        endLine: finding.endLine,
        column: finding.column,
        helpUrl: finding.helpUrl,
        snippet: finding.snippet,
        fingerprint: finding.fingerprint,
        preexisting: finding.preexisting,
        // Provenance: which tool run produced this. The audit chain depends on it.
        sourceToolRunId: finding.sourceToolRunId,
      })),

      // ---- retrieved repository context, as the AI actually saw it
      ragContext: run.retrievedChunks.map((chunk) => ({
        id: chunk.id,
        forFilePath: chunk.forFilePath,
        chunkId: chunk.chunkId,
        path: chunk.path,
        symbol: chunk.symbol,
        kind: chunk.kind,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenCount: chunk.tokenCount,
        score: chunk.score,
        vectorScore: chunk.vectorScore,
        lexicalScore: chunk.lexicalScore,
        sources: chunk.sources,
        rationale: chunk.rationale,
        rank: chunk.rank,
      })),

      // ---- AI review
      aiReview: ai
        ? {
            id: ai.id,
            executiveSummary: ai.executiveSummary,
            technicalSummary: ai.technicalSummary,
            beginnerExplanation: ai.beginnerExplanation,
            recommendationRationale: ai.recommendationRationale,
            modelRecommendation: ai.modelRecommendation as ApprovalRecommendation,
            effectiveRecommendation: ai.effectiveRecommendation as ApprovalRecommendation,
            policyOverridden: ai.policyOverridden,
            policyReasons: ai.policyReasons,
            confidence: ai.confidence,
            fileExplanations: (ai.fileExplanations ?? []) as unknown as FileExplanation[],
            findings: (ai.findings ?? []) as unknown as AiFinding[],
            missingTests: (ai.missingTests ?? []) as unknown as string[],
            suggestedTestCases: (ai.suggestedTestCases ?? []) as unknown as SuggestedTestCase[],
            reviewerChecklist: (ai.reviewerChecklist ?? []) as unknown as ChecklistItem[],
            openQuestions: (ai.openQuestions ?? []) as unknown as string[],
            droppedFindingCount: ai.droppedFindingCount,
            usedMapReduce: ai.usedMapReduce,
            provider: ai.provider,
            model: ai.model,
            promptVersion: ai.promptVersion,
            tokenUsage: {
              prompt: ai.promptTokens,
              completion: ai.completionTokens,
              total: ai.promptTokens + ai.completionTokens,
            },
            costCents: ai.costCents,
            createdAt: ai.createdAt.toISOString(),
          }
        : null,

      // ---- the audit spine
      toolRuns: run.toolRuns.map((tool) => ({
        id: tool.id,
        tool: tool.tool,
        status: tool.status,
        sequence: tool.sequence,
        durationMs: tool.durationMs,
        cacheHit: tool.cacheHit,
        error: tool.error,
        costCents: tool.costCents,
        tokenUsage:
          tool.promptTokens !== null
            ? {
                prompt: tool.promptTokens,
                completion: tool.completionTokens ?? 0,
                total: (tool.promptTokens ?? 0) + (tool.completionTokens ?? 0),
              }
            : null,
        startedAt: tool.startedAt.toISOString(),
        finishedAt: tool.finishedAt?.toISOString() ?? null,
        output: tool.output,
      })),

      metrics: run.metrics
        ? {
            linesAdded: run.metrics.linesAdded,
            linesDeleted: run.metrics.linesDeleted,
            filesChanged: run.metrics.filesChanged,
            commitCount: run.metrics.commitCount,
            functionsChanged: run.metrics.functionsChanged,
            complexityBefore: run.metrics.complexityBefore,
            complexityAfter: run.metrics.complexityAfter,
            complexityDelta: run.metrics.complexityDelta,
            maxFunctionComplexity: run.metrics.maxFunctionComplexity,
            securityFindingsCount: run.metrics.securityFindingsCount,
            testFilesChanged: run.metrics.testFilesChanged,
            testToCodeRatio: run.metrics.testToCodeRatio,
            dependencyChanged: run.metrics.dependencyChanged,
            authFileChanged: run.metrics.authFileChanged,
            databaseFileChanged: run.metrics.databaseFileChanged,
            configFileChanged: run.metrics.configFileChanged,
            paymentFileChanged: run.metrics.paymentFileChanged,
            infraFileChanged: run.metrics.infraFileChanged,
            previousRiskyFileCount: run.metrics.previousRiskyFileCount,
          }
        : null,

      degradation,
    };
  }

  /** Lightweight run status, for polling while an analysis is in flight. */
  async getRunStatus(organizationId: string, reviewRunId: string) {
    const run = await this.prisma.unscoped.reviewRun.findFirst({
      where: { id: reviewRunId, organizationId },
      include: {
        toolRuns: {
          orderBy: { sequence: 'asc' },
          select: {
            tool: true,
            status: true,
            sequence: true,
            durationMs: true,
            error: true,
          },
        },
      },
    });

    if (!run) throw new NotFoundError('Review run', reviewRunId);

    return {
      id: run.id,
      pullRequestId: run.pullRequestId,
      status: run.status,
      stage: run.stage,
      progress: reviewRunProgress(run.stage as ReviewStage, REVIEW_STAGE_ORDER),
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.durationMs,
      costCents: run.costCents,
      toolRuns: run.toolRuns,
    };
  }
}
