import { Injectable, Logger } from '@nestjs/common';
import {
  RISK_LEVEL_COLORS,
  SEVERITY_RANK,
  Severity,
  formatMinutes,
  severityAtLeast,
  type PostGithubCommentInput,
} from '@codelens/shared';
import {
  AnalyzerKind,
  ApprovalRecommendation,
  FindingCategory,
  MlStatus,
  RiskLevel,
  type Prisma,
} from '@codelens/database';
import { PrismaService } from '../prisma/prisma.service';
import { RagService } from '../rag/rag.service';
import type { RunState } from './run-scratchpad';

/**
 * Durable persistence for an analysis run, plus GitHub comment rendering.
 *
 * Separated from the tools so that `create_review_report` stays a thin adapter and every
 * database write for a run lives in one auditable place.
 *
 * Wrapped in a single transaction: a report is either fully written or not at all. A
 * half-persisted review — findings but no risk score, or a risk score with no findings — would
 * be worse than a failed run, because it looks complete.
 */
@Injectable()
export class ReportWriter {
  private readonly logger = new Logger(ReportWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
  ) {}

  async persist(params: {
    organizationId: string;
    reviewRunId: string;
    pullRequestId: string;
    state: RunState;
    staticAnalysisToolRunId: string | null;
  }): Promise<{
    reviewRunId: string;
    pullRequestId: string;
    findingsPersisted: number;
    metricsPersisted: boolean;
    predictionPersisted: boolean;
    aiReviewPersisted: boolean;
    contextChunksPersisted: number;
    riskScore: number | null;
    riskLevel: string | null;
  }> {
    const { state } = params;

    const findings = (state.staticAnalysis?.results ?? []).flatMap((result) => result.findings);
    const riskScore = state.prediction?.response.risk_score ?? null;
    const riskLevel = state.prediction?.response.risk_level ?? null;

    // Context is written outside the transaction because it can be thousands of rows and is
    // regenerable; holding a transaction open for it would lock for longer than warranted.
    const contextChunksPersisted = state.context
      ? await this.rag.persistRetrievedContext(params.reviewRunId, state.context)
      : 0;

    await this.prisma.unscoped.$transaction(async (tx) => {
      // ---- static findings
      //
      // Deleted then recreated so a re-run replaces its own findings rather than accumulating
      // duplicates against the unique (reviewRunId, fingerprint) constraint.
      await tx.staticFinding.deleteMany({ where: { reviewRunId: params.reviewRunId } });

      if (findings.length > 0 && params.staticAnalysisToolRunId) {
        // Deduplicate on fingerprint: two analyzers can flag the same line, and the unique
        // constraint would otherwise abort the whole transaction.
        const seen = new Set<string>();
        const rows: Prisma.StaticFindingCreateManyInput[] = [];

        for (const finding of findings) {
          if (seen.has(finding.fingerprint)) continue;
          seen.add(finding.fingerprint);

          rows.push({
            organizationId: params.organizationId,
            reviewRunId: params.reviewRunId,
            sourceToolRunId: params.staticAnalysisToolRunId,
            analyzer: finding.analyzer as AnalyzerKind,
            ruleId: finding.ruleId,
            severity: finding.severity as Severity,
            category: finding.category as FindingCategory,
            message: finding.message,
            path: finding.path,
            line: finding.line,
            endLine: finding.endLine,
            column: finding.column,
            helpUrl: finding.helpUrl,
            snippet: finding.snippet,
            fingerprint: finding.fingerprint,
            preexisting: finding.preexisting,
          });
        }

        if (rows.length > 0) {
          await tx.staticFinding.createMany({ data: rows });
        }
      } else if (findings.length > 0) {
        this.logger.warn(
          `${findings.length} finding(s) were discarded because no successful ` +
            `run_static_analysis ToolRun exists to attribute them to. A finding without ` +
            `provenance cannot be audited.`,
        );
      }

      // ---- metrics (the persisted ML feature vector)
      if (state.metrics && state.features) {
        await tx.prMetrics.deleteMany({ where: { reviewRunId: params.reviewRunId } });
        await tx.prMetrics.create({
          data: {
            reviewRunId: params.reviewRunId,
            linesAdded: state.metrics.linesAdded,
            linesDeleted: state.metrics.linesDeleted,
            filesChanged: state.metrics.filesChanged,
            commitCount: state.metrics.commitCount,
            functionsChanged: state.metrics.functionsChanged,
            complexityBefore: Math.round(state.metrics.complexityBefore),
            complexityAfter: Math.round(state.metrics.complexityAfter),
            complexityDelta: Math.round(state.metrics.complexityDelta),
            maxFunctionComplexity: Math.round(state.metrics.maxFunctionComplexity),
            securityFindingsCount: state.metrics.securityFindingsCount,
            testFilesChanged: state.metrics.testFilesChanged,
            testToCodeRatio: state.metrics.testToCodeRatio,
            dependencyChanged: state.metrics.dependencyChanged,
            authFileChanged: state.metrics.authFileChanged,
            databaseFileChanged: state.metrics.databaseFileChanged,
            configFileChanged: state.metrics.configFileChanged,
            paymentFileChanged: state.metrics.paymentFileChanged,
            infraFileChanged: state.metrics.infraFileChanged,
            previousRiskyFileCount: state.metrics.previousRiskyFileCount,
            // Stored so the TF-IDF vectorizers can be refitted during retraining without
            // refetching from GitHub.
            titleText: state.features.title_text,
            commitText: state.features.commit_text,
            featureSchemaVersion: 1,
          },
        });
      }

      // ---- ML prediction
      if (state.prediction) {
        const prediction = state.prediction;

        await tx.mlPrediction.deleteMany({ where: { reviewRunId: params.reviewRunId } });
        await tx.mlPrediction.create({
          data: {
            organizationId: params.organizationId,
            reviewRunId: params.reviewRunId,
            status: prediction.degradedReason ? MlStatus.DEGRADED : MlStatus.OK,
            degradedReason: prediction.degradedReason,
            riskScore: Math.round(prediction.response.risk_score),
            riskLevel: (riskLevel ?? RiskLevel.LOW) as RiskLevel,
            probability: prediction.response.probability,
            confidence: prediction.response.confidence,
            isBaseline: prediction.response.is_baseline,
            predictedReviewTimeMinutes: prediction.reviewTimeMinutes,
            reviewTimeLowerMinutes: prediction.reviewTimeRange?.lower ?? null,
            reviewTimeUpperMinutes: prediction.reviewTimeRange?.upper ?? null,
            topRiskReasons: prediction.response.top_risk_reasons as unknown as Prisma.InputJsonValue,
            similarPullRequests: prediction.similar as unknown as Prisma.InputJsonValue,
            issueClusters: [] as unknown as Prisma.InputJsonValue,
            modelName: prediction.response.model_name,
            modelVersion: prediction.response.model_version,
            featureSchemaVersion: 1,
          },
        });
      }

      // ---- AI review
      if (state.aiReview) {
        const ai = state.aiReview;

        // Test suggestions are generated after the review, so merge them in rather than
        // letting the later tool overwrite the row.
        const suggestedTestCases =
          state.testSuggestions && state.testSuggestions.length > 0
            ? state.testSuggestions
            : ai.review.suggestedTestCases;

        await tx.aiReview.deleteMany({ where: { reviewRunId: params.reviewRunId } });
        await tx.aiReview.create({
          data: {
            organizationId: params.organizationId,
            reviewRunId: params.reviewRunId,
            executiveSummary: ai.review.executiveSummary,
            technicalSummary: ai.review.technicalSummary,
            beginnerExplanation: ai.review.beginnerExplanation,
            recommendationRationale: ai.review.recommendationRationale,
            modelRecommendation: ai.review.approvalRecommendation as ApprovalRecommendation,
            effectiveRecommendation: ai.effectiveRecommendation as ApprovalRecommendation,
            policyOverridden: ai.policyOverridden,
            policyReasons: ai.policyReasons,
            confidence: ai.review.confidence,
            fileExplanations: ai.review.fileExplanations as unknown as Prisma.InputJsonValue,
            findings: ai.review.findings as unknown as Prisma.InputJsonValue,
            missingTests: ai.review.missingTests as unknown as Prisma.InputJsonValue,
            suggestedTestCases: suggestedTestCases as unknown as Prisma.InputJsonValue,
            reviewerChecklist: ai.review.reviewerChecklist as unknown as Prisma.InputJsonValue,
            openQuestions: ai.review.openQuestions as unknown as Prisma.InputJsonValue,
            droppedFindingCount: ai.droppedFindingCount,
            usedMapReduce: ai.usedMapReduce,
            provider: ai.provider,
            model: ai.model,
            promptVersion: ai.promptVersion,
            promptTokens: ai.tokenUsage.prompt,
            completionTokens: ai.tokenUsage.completion,
            costCents: ai.costCents,
          },
        });
      }

      // ---- denormalised risk on the pull request, for list sorting and filtering
      if (riskScore !== null && riskLevel !== null) {
        await tx.pullRequest.update({
          where: { id: params.pullRequestId },
          data: {
            latestRiskScore: Math.round(riskScore),
            latestRiskLevel: riskLevel as RiskLevel,
          },
        });
      }
    });

    return {
      reviewRunId: params.reviewRunId,
      pullRequestId: params.pullRequestId,
      findingsPersisted: findings.length,
      metricsPersisted: Boolean(state.metrics),
      predictionPersisted: Boolean(state.prediction),
      aiReviewPersisted: Boolean(state.aiReview),
      contextChunksPersisted,
      riskScore,
      riskLevel,
    };
  }

  /**
   * Render the GitHub comment.
   *
   * Written to be genuinely useful in a PR thread rather than a dump of everything the run
   * produced. A comment nobody reads is worse than no comment, so it leads with the
   * recommendation, shows only findings at or above the requested severity, and links back to
   * the full report instead of inlining it.
   */
  renderGithubComment(params: {
    state: RunState;
    options: PostGithubCommentInput;
    webUrl: string;
    pullRequestId: string;
  }): string | null {
    const { state, options } = params;
    const ai = state.aiReview;

    if (!ai) return null;

    const lines: string[] = [];

    const verdictLabel: Record<string, string> = {
      APPROVE: '✅ Looks good',
      REQUEST_CHANGES: '🔴 Changes requested',
      NEEDS_DISCUSSION: '💬 Needs discussion',
    };

    lines.push(`## CodeLens review — ${verdictLabel[ai.effectiveRecommendation] ?? 'Reviewed'}`);
    lines.push('');
    lines.push(ai.review.executiveSummary);
    lines.push('');

    // ---- risk
    if (options.includeRiskScore && state.prediction) {
      const prediction = state.prediction;
      const level = prediction.response.risk_level;

      lines.push(
        `**Risk ${Math.round(prediction.response.risk_score)}/100 (${level})**` +
          (prediction.response.is_baseline
            ? ' — from a heuristic baseline, not a model trained on this repository'
            : '') +
          (prediction.reviewTimeMinutes
            ? ` · estimated review time ${formatMinutes(prediction.reviewTimeMinutes)}`
            : ''),
      );

      const topReasons = prediction.response.top_risk_reasons
        .filter((reason) => reason.direction === 'INCREASES_RISK')
        .slice(0, 3);

      if (topReasons.length > 0) {
        lines.push('');
        for (const reason of topReasons) {
          lines.push(`- ${reason.label} (${reason.value}) — ${reason.explanation}`);
        }
      }
      lines.push('');
    }

    // ---- policy override, stated plainly
    if (ai.policyOverridden && ai.policyReasons.length > 0) {
      lines.push(
        `> The model suggested **${ai.review.approvalRecommendation}**, but organization ` +
          `policy requires **${ai.effectiveRecommendation}**:`,
      );
      for (const reason of ai.policyReasons) lines.push(`> - ${reason}`);
      lines.push('');
    }

    // ---- findings
    const threshold = options.minSeverity;
    const visible = ai.review.findings
      .filter((finding) => severityAtLeast(finding.severity, threshold))
      .filter(
        (finding) =>
          options.categories.length === 0 ||
          options.categories.includes(finding.category),
      )
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

    if (visible.length > 0) {
      lines.push(`### Findings (${visible.length} at ${threshold} or above)`);
      lines.push('');

      for (const finding of visible.slice(0, 20)) {
        const location = finding.path
          ? `\`${finding.path}${finding.line ? `:${finding.line}` : ''}\``
          : '_repository_';

        lines.push(`#### ${severityBadge(finding.severity)} ${finding.title}`);
        lines.push(`${location} · ${finding.category}`);
        lines.push('');
        lines.push(finding.explanation);

        if (finding.suggestedFix) {
          lines.push('');
          lines.push('<details><summary>Suggested fix</summary>');
          lines.push('');
          lines.push('```');
          lines.push(finding.suggestedFix);
          lines.push('```');
          lines.push('');
          lines.push('</details>');
        }
        lines.push('');
      }

      if (visible.length > 20) {
        lines.push(`_…and ${visible.length - 20} more in the full report._`);
        lines.push('');
      }
    } else {
      lines.push(`_No findings at ${threshold} severity or above._`);
      lines.push('');
    }

    // ---- missing tests
    if (ai.review.missingTests.length > 0) {
      lines.push('### Untested behaviour');
      lines.push('');
      for (const gap of ai.review.missingTests.slice(0, 8)) lines.push(`- ${gap}`);
      lines.push('');
    }

    // ---- file breakdown, collapsed because it is long
    if (options.includeFileBreakdown && ai.review.fileExplanations.length > 0) {
      lines.push('<details><summary>File-by-file breakdown</summary>');
      lines.push('');

      for (const file of ai.review.fileExplanations.slice(0, 40)) {
        lines.push(`**\`${file.path}\`** — ${file.whatChanged}`);
        if (file.concerns.length > 0) {
          for (const concern of file.concerns.slice(0, 4)) lines.push(`  - ${concern}`);
        }
        lines.push('');
      }

      lines.push('</details>');
      lines.push('');
    }

    // ---- checklist
    if (options.includeChecklist && ai.review.reviewerChecklist.length > 0) {
      lines.push('### Reviewer checklist');
      lines.push('');

      for (const item of ai.review.reviewerChecklist) {
        const mark =
          item.status === 'LIKELY_SATISFIED'
            ? 'x'
            : ' ';
        const note =
          item.status === 'NEEDS_ATTENTION'
            ? ' ⚠️'
            : item.status === 'CANNOT_DETERMINE'
              ? ' ❓'
              : '';
        lines.push(`- [${mark}] ${item.item}${note}`);
      }
      lines.push('');
    }

    if (ai.review.openQuestions.length > 0) {
      lines.push('### Open questions');
      lines.push('');
      for (const question of ai.review.openQuestions.slice(0, 5)) lines.push(`- ${question}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(
      `[View the full report](${params.webUrl}/pull-requests/${params.pullRequestId}) · ` +
        `${ai.provider}/${ai.model} · prompt ${ai.promptVersion}` +
        (ai.droppedFindingCount > 0
          ? ` · ${ai.droppedFindingCount} unsupported finding(s) filtered`
          : ''),
    );

    return lines.join('\n');
  }
}

function severityBadge(severity: Severity): string {
  const badges: Record<Severity, string> = {
    CRITICAL: '🔴 **CRITICAL**',
    HIGH: '🟠 **HIGH**',
    MEDIUM: '🟡 MEDIUM',
    LOW: '🔵 LOW',
    INFO: '⚪ INFO',
  };
  return badges[severity];
}

export { RISK_LEVEL_COLORS };
