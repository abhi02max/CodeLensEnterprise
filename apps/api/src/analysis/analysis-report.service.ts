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
      const skipped = run.toolRuns.find((tool) => tool.tool === 'generate_ai_review');
      const reason =
        skipped?.output && typeof skipped.output === 'object' && !Array.isArray(skipped.output)
          ? ((skipped.output as Record<string, unknown>).skippedReason as string | undefined)
          : undefined;

      degradation.push(reason ?? 'The AI review was not generated for this run.');
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
