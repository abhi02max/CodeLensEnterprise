import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  Analyzer,
  FileFlag,
  MAX_FILES_PER_REVIEW,
  PROMPT_VERSION,
  Role,
  Severity,
  ToolName,
  ToolSideEffect,
  isAnalyzable,
  redactSecrets,
  riskLevelFromScore,
  roleAtLeast,
  toErrorMessage,
  type McpTool,
  type PrFeatures,
} from '@codelens/shared';
import { FEATURE_SCHEMA_VERSION } from '@codelens/shared';
import { formatHunksForPrompt, parseUnifiedPatch, reconstructSides } from '@codelens/github';
import {
  countPreviousRiskyFiles,
  extractMetrics,
  runStaticAnalysis,
  toPrFeatures,
  type AnalyzerFile,
} from '@codelens/static-analysis';
import { ReviewGenerator, createProvider } from '@codelens/ai-agent';
import { defineTool, plainMeta } from '@codelens/ai-agent';
import { NestToolLogger } from '../common/tool-logger';
import { PolicyViolationError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit-logs/audit.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { PolicyService } from '../organizations/policy.service';
import { MlService } from '../ml/ml.service';
import { RagService } from '../rag/rag.service';
import { PullRequestsService } from '../pull-requests/pull-requests.service';
import { RunScratchpad } from '../analysis/run-scratchpad';
import { ReportWriter } from '../analysis/report-writer.service';
import * as S from './tool-io.schemas';

/**
 * The eleven MCP tools.
 *
 * Each tool is a self-contained capability with a typed, Zod-validated interface. They are
 * registered into `McpToolRegistry` from `packages/ai-agent`, which enforces — uniformly and
 * before any tool body runs — that the input validates, the caller's role is sufficient, an
 * external write is not happening on a dry run, and the output validates.
 *
 * Three cross-cutting properties hold for every tool:
 *
 *   TENANT SCOPING. Every database read filters on `ctx.organizationId`. No tool takes a
 *   bare record id and trusts it.
 *
 *   NO SECRET LEAKAGE. `run_static_analysis` detects secrets; `generate_ai_review` redacts
 *   them before the diff reaches a provider and refuses entirely if policy says so. Tool
 *   outputs carry masked excerpts only.
 *
 *   SUMMARY OUTPUTS. A tool's `output` is a compact record for the audit trail; bulk payloads
 *   live in the {@link RunScratchpad} and are durably persisted by `create_review_report`.
 */
@Injectable()
export class ToolsFactory {
  private readonly logger = new Logger(ToolsFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly github: GithubClientFactory,
    private readonly policy: PolicyService,
    private readonly ml: MlService,
    private readonly rag: RagService,
    private readonly pullRequests: PullRequestsService,
    private readonly scratchpad: RunScratchpad,
    private readonly audit: AuditService,
    private readonly reportWriter: ReportWriter,
  ) {}

  /** All eleven tools, in pipeline order. */
  build(): McpTool<never, never>[] {
    return [
      this.getPrDiff(),
      this.getRepoMetadata(),
      this.runStaticAnalysisTool(),
      this.extractMlFeatures(),
      this.predictPrRisk(),
      this.retrieveCodeContext(),
      this.generateAiReview(),
      this.generateTestSuggestions(),
      this.createReviewReport(),
      this.postGithubComment(),
      this.createAuditLog(),
    ] as unknown as McpTool<never, never>[];
  }

  // ================================================================ 1. get_pr_diff

  /**
   * Load the pull request and its diff.
   *
   * Reads the stored diff when one is present and only calls GitHub when it is missing or a
   * refresh is requested. That is partly a caching decision — a diff for a fixed head SHA is
   * immutable, so refetching it is pure waste — and partly what makes the pipeline runnable
   * against imported or seeded data without a live GitHub connection.
   */
  private getPrDiff() {
    return defineTool({
      name: ToolName.GET_PR_DIFF,
      description:
        'Load a pull request with its metadata, changed files, unified diff patches and ' +
        'commit messages. Uses the stored diff when available.',
      inputSchema: S.GetPrDiffInput,
      outputSchema: S.GetPrDiffOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: false,
      timeoutMs: 90_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();

        const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
          where: { id: input.pullRequestId, organizationId: ctx.organizationId },
          include: {
            repository: { select: { id: true, fullName: true } },
            files: { orderBy: { filename: 'asc' } },
            commits: { orderBy: { authoredAt: 'asc' } },
          },
        });

        if (!pullRequest) {
          throw new Error(`Pull request ${input.pullRequestId} not found in this organization`);
        }

        let files = pullRequest.files;
        let commits = pullRequest.commits;
        let cacheHit = true;

        if (input.refresh || files.length === 0) {
          ctx.logger.info('Fetching diff from GitHub', {
            repository: pullRequest.repository.fullName,
            number: pullRequest.number,
            reason: input.refresh ? 'refresh requested' : 'no stored diff',
          });

          await this.pullRequests.importFromGithub(ctx.organizationId, {
            repositoryId: pullRequest.repositoryId,
            number: pullRequest.number,
            userId: ctx.userId,
          });

          const refreshed = await this.prisma.unscoped.pullRequest.findFirstOrThrow({
            where: { id: input.pullRequestId, organizationId: ctx.organizationId },
            include: {
              files: { orderBy: { filename: 'asc' } },
              commits: { orderBy: { authoredAt: 'asc' } },
            },
          });

          files = refreshed.files;
          commits = refreshed.commits;
          cacheHit = false;
        }

        const output = {
          pullRequestId: pullRequest.id,
          repositoryId: pullRequest.repositoryId,
          repositoryFullName: pullRequest.repository.fullName,
          number: pullRequest.number,
          title: pullRequest.title,
          body: pullRequest.body,
          authorLogin: pullRequest.authorLogin,
          headSha: pullRequest.headSha,
          baseSha: pullRequest.baseSha,
          headRef: pullRequest.headRef,
          baseRef: pullRequest.baseRef,
          additions: pullRequest.additions,
          deletions: pullRequest.deletions,
          changedFiles: pullRequest.changedFiles,
          commitMessages: commits.map((commit) => commit.message),
          files: files.slice(0, MAX_FILES_PER_REVIEW).map((file) => ({
            filename: file.filename,
            status: file.status,
            language: file.language,
            flags: file.flags,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch,
            patchTruncated: file.patchTruncated,
            binary: file.binary,
            analyzable: isAnalyzable(file.filename),
            touchedLines: file.touchedLines,
          })),
        };

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, { diff: output });
        }

        return {
          output,
          meta: { ...plainMeta(Date.now() - startedAt), cacheHit },
        };
      },
    });
  }

  // ================================================================ 2. get_repo_metadata

  /**
   * Repository context for the run.
   *
   * Also computes `riskyPaths` — files with a history of trouble in this repository, derived
   * from prior runs that produced high-severity findings and from pull requests that received
   * CHANGES_REQUESTED. This is the input to `previous_risky_file_count`, which is the only ML
   * feature encoding the organization's own history rather than a generic heuristic.
   */
  private getRepoMetadata() {
    return defineTool({
      name: ToolName.GET_REPO_METADATA,
      description:
        'Repository metadata, index status, root configuration files, and paths with a ' +
        'history of review problems in this repository.',
      inputSchema: S.GetRepoMetadataInput,
      outputSchema: S.GetRepoMetadataOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: true,
      timeoutMs: 30_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();

        const repository = await this.prisma.unscoped.repository.findFirst({
          where: { id: input.repositoryId, organizationId: ctx.organizationId },
        });

        if (!repository) {
          throw new Error(`Repository ${input.repositoryId} not found in this organization`);
        }

        // Config files are read from the index rather than GitHub: it is free, and a repository
        // that has not been indexed cannot run the config-dependent analyzers anyway.
        const rootChunks = await this.prisma.unscoped.ragChunk.findMany({
          where: {
            repositoryId: repository.id,
            organizationId: ctx.organizationId,
            path: { not: { contains: '/' } },
          },
          select: { path: true },
          distinct: ['path'],
          take: 100,
        });

        const riskyPaths = await this.computeRiskyPaths(ctx.organizationId, repository.id);

        const output = {
          repositoryId: repository.id,
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          primaryLanguage: repository.primaryLanguage,
          description: repository.description,
          private: repository.private,
          indexed: repository.indexStatus === 'INDEXED',
          indexedChunkCount: repository.indexedChunkCount,
          indexedAt: repository.indexedAt?.toISOString() ?? null,
          repoConfigFiles: rootChunks.map((chunk) => chunk.path),
          riskyPaths,
        };

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, { repoMetadata: output });
        }

        return { output, meta: plainMeta(Date.now() - startedAt) };
      },
    });
  }

  /**
   * Paths with a track record of problems in this repository.
   *
   * Two signals, both drawn from the organization's own history:
   *   - files carrying HIGH or CRITICAL findings in previous completed runs
   *   - files changed by pull requests that received CHANGES_REQUESTED
   */
  private async computeRiskyPaths(
    organizationId: string,
    repositoryId: string,
  ): Promise<string[]> {
    const [findingPaths, rejectedPrFiles] = await Promise.all([
      this.prisma.unscoped.staticFinding.groupBy({
        by: ['path'],
        where: {
          organizationId,
          severity: { in: [Severity.CRITICAL, Severity.HIGH] },
          preexisting: false,
          reviewRun: { pullRequest: { repositoryId } },
        },
        _count: { _all: true },
        // Prisma requires orderBy alongside take on a groupBy.
        orderBy: { _count: { path: 'desc' } },
        take: 200,
      }),
      this.prisma.unscoped.pullRequestFile.findMany({
        where: {
          pullRequest: {
            repositoryId,
            organizationId,
            reviews: { some: { verdict: 'CHANGES_REQUESTED' } },
          },
        },
        select: { filename: true },
        distinct: ['filename'],
        take: 200,
      }),
    ]);

    const paths = new Set<string>();

    for (const row of findingPaths) {
      if (row.path) paths.add(row.path);
    }
    for (const row of rejectedPrFiles) {
      paths.add(row.filename);
    }

    return [...paths];
  }

  // ================================================================ 3. run_static_analysis

  /**
   * Run the deterministic analyzers.
   *
   * File content is reconstructed from the diff hunks rather than fetched from GitHub. That is
   * the right trade: analyzers only need the changed regions plus enough surrounding context
   * to parse, and fetching two full blobs per file would add hundreds of API calls to a large
   * pull request for no additional findings on the lines under review.
   *
   * Every analyzer degrades independently. Semgrep missing, no ESLint config and an
   * unreachable npm registry still yields metrics, complexity and secret-scan results.
   */
  private runStaticAnalysisTool() {
    return defineTool({
      name: ToolName.RUN_STATIC_ANALYSIS,
      description:
        'Run ESLint, Semgrep, npm audit, secret scanning and complexity analysis over the ' +
        'changed files, scoping findings to lines this pull request touched.',
      inputSchema: S.RunStaticAnalysisInput,
      outputSchema: S.RunStaticAnalysisOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: false,
      timeoutMs: 180_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();

        const state = ctx.reviewRunId ? this.scratchpad.require(ctx.reviewRunId) : null;
        const diff = state?.diff;

        if (!diff) {
          throw new Error('run_static_analysis requires get_pr_diff to have run first');
        }

        const policy = await this.policy.getPolicy(ctx.organizationId);

        // Reconstruct both sides of each changed file from its hunks.
        const analyzerFiles: AnalyzerFile[] = diff.files.map((file) => {
          const hunks = file.patch ? parseUnifiedPatch(file.patch) : [];
          const sides = reconstructSides(hunks);

          return {
            path: file.filename,
            content: sides.after,
            previousContent: sides.before,
            language: file.language,
            flags: file.flags as FileFlag[],
            analyzable: file.analyzable && !file.binary,
            touchedLines: new Set(file.touchedLines),
            additions: file.additions,
            deletions: file.deletions,
          };
        });

        // Manifests the dependency analyzer needs, pulled from the diff when present.
        const manifests: Record<string, string> = {};
        for (const file of diff.files) {
          const basename = file.filename.split('/').pop() ?? file.filename;
          if (basename === 'package.json' && file.patch) {
            const sides = reconstructSides(parseUnifiedPatch(file.patch));
            manifests['package.json'] = sides.after;
          }
        }

        const summary = await runStaticAnalysis(
          {
            files: analyzerFiles,
            repoConfigFiles: state?.repoMetadata?.repoConfigFiles ?? [],
            manifests,
            extraSemgrepRulesets: policy.extraSemgrepRulesets,
          },
          {
            tmpDir: this.config.analysis.tmpDir,
            runId: ctx.reviewRunId ?? `adhoc-${Date.now()}`,
            timeoutMs: this.config.analysis.timeoutMs,
            enableEslint: this.config.analysis.enableEslint,
            enableSemgrep: this.config.analysis.enableSemgrep,
            enableNpmAudit: this.config.analysis.enableNpmAudit,
            enableSecretScan: true,
            semgrepBinary: this.config.analysis.semgrepBinary,
            semgrepRulesets: this.config.analysis.semgrepRulesets,
            minSeverity: Severity.INFO,
          },
        );

        // Commit count and repository history are owned by the caller, not the analyzers.
        const metrics = {
          ...summary.metrics,
          commitCount: diff.commitMessages.length,
          previousRiskyFileCount: countPreviousRiskyFiles(
            diff.files.map((file) => file.filename),
            new Set(state?.repoMetadata?.riskyPaths ?? []),
          ),
        };

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, {
            staticAnalysis: { ...summary, metrics },
            metrics,
          });
        }

        const allFindings = summary.results.flatMap((result) => result.findings);

        for (const result of summary.results) {
          if (result.status !== 'SUCCESS') {
            ctx.logger.warn(`${result.analyzer} ${result.status}`, { error: result.error });
          }
        }

        return {
          output: {
            analyzers: summary.results.map((result) => ({
              analyzer: result.analyzer,
              status: result.status,
              findingCount: result.findings.length,
              durationMs: result.durationMs,
              error: result.error,
              filesAnalyzed: result.filesAnalyzed,
            })),
            findings: allFindings.map((finding) => ({
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
            })),
            totalFindings: summary.totalFindings,
            newFindings: summary.newFindings,
            preexistingFindings: summary.preexistingFindings,
            countsBySeverity: summary.countsBySeverity,
            secretsDetected: summary.secretsDetected,
            metrics: {
              linesAdded: metrics.linesAdded,
              linesDeleted: metrics.linesDeleted,
              filesChanged: metrics.filesChanged,
              functionsChanged: metrics.functionsChanged,
              complexityBefore: metrics.complexityBefore,
              complexityAfter: metrics.complexityAfter,
              complexityDelta: metrics.complexityDelta,
              maxFunctionComplexity: metrics.maxFunctionComplexity,
              securityFindingsCount: metrics.securityFindingsCount,
              testFilesChanged: metrics.testFilesChanged,
              hasTests: metrics.hasTests,
              testToCodeRatio: metrics.testToCodeRatio,
              dependencyChanged: metrics.dependencyChanged,
              authFileChanged: metrics.authFileChanged,
              databaseFileChanged: metrics.databaseFileChanged,
              configFileChanged: metrics.configFileChanged,
              paymentFileChanged: metrics.paymentFileChanged,
              infraFileChanged: metrics.infraFileChanged,
            },
          },
          meta: plainMeta(Date.now() - startedAt),
        };
      },
    });
  }

  // ================================================================ 4. extract_ml_features

  /**
   * Build the ML feature vector.
   *
   * Runs even when static analysis failed, with finding counts zeroed and the result marked
   * degraded. A risk score computed without security findings is weaker but still useful;
   * refusing to score at all would lose the size, complexity and history signals too.
   */
  private extractMlFeatures() {
    return defineTool({
      name: ToolName.EXTRACT_ML_FEATURES,
      description:
        'Build the deterministic ML feature vector for a pull request from its diff, ' +
        'static analysis metrics and repository history.',
      inputSchema: S.ExtractMlFeaturesInput,
      outputSchema: S.ExtractMlFeaturesOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: false,
      timeoutMs: 30_000,
      execute: async (_input, ctx) => {
        const startedAt = Date.now();
        const state = ctx.reviewRunId ? this.scratchpad.require(ctx.reviewRunId) : null;
        const diff = state?.diff;

        if (!diff) {
          throw new Error('extract_ml_features requires get_pr_diff to have run first');
        }

        const degraded = !state?.metrics;
        const degradedReason = degraded
          ? 'Static analysis did not complete, so security finding counts and complexity are zero'
          : null;

        // Fall back to diff-only metrics when the analyzers did not run.
        const metrics =
          state?.metrics ??
          (() => {
            const base = extractMetrics(
              {
                files: diff.files.map((file) => ({
                  path: file.filename,
                  content: '',
                  previousContent: '',
                  language: file.language,
                  flags: file.flags as FileFlag[],
                  analyzable: file.analyzable,
                  touchedLines: new Set(file.touchedLines),
                  additions: file.additions,
                  deletions: file.deletions,
                })),
                repoConfigFiles: [],
                manifests: {},
                extraSemgrepRulesets: [],
              },
              [],
            );
            return { ...base, commitCount: diff.commitMessages.length };
          })();

        const features: PrFeatures = toPrFeatures({
          metrics,
          commitCount: diff.commitMessages.length,
          previousRiskyFileCount: metrics.previousRiskyFileCount,
          title: diff.title,
          commitMessages: diff.commitMessages,
        });

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, { features, metrics });
        }

        return {
          output: {
            features,
            featureSchemaVersion: FEATURE_SCHEMA_VERSION,
            degraded,
            degradedReason,
          },
          meta: plainMeta(Date.now() - startedAt),
        };
      },
    });
  }

  // ================================================================ 5. predict_pr_risk

  /**
   * Call the ML service for risk, review time and similar pull requests.
   *
   * Returns `status: UNAVAILABLE` rather than throwing when the service is down, so the
   * pipeline records a run without a risk score instead of failing outright.
   */
  private predictPrRisk() {
    return defineTool({
      name: ToolName.PREDICT_PR_RISK,
      description:
        'Predict pull request risk with SHAP-attributed reasons, estimate human review ' +
        'time, and find similar historical pull requests and their outcomes.',
      inputSchema: S.PredictPrRiskInput,
      outputSchema: S.PredictPrRiskOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: false,
      timeoutMs: 45_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();

        const risk = await this.ml.predictRisk({
          features: input.features,
          organizationId: ctx.organizationId,
          includeExplanation: input.includeExplanation,
        });

        if (risk.status === 'UNAVAILABLE') {
          ctx.logger.warn('ML risk prediction unavailable', { reason: risk.reason });

          return {
            output: {
              status: 'UNAVAILABLE' as const,
              riskScore: 0,
              riskLevel: 'LOW' as const,
              probability: 0,
              confidence: 0,
              isBaseline: true,
              topRiskReasons: [],
              predictedReviewTimeMinutes: null,
              reviewTimeRange: null,
              similarPullRequests: [],
              modelName: 'unavailable',
              modelVersion: 'unavailable',
              degradedReason: risk.reason,
            },
            meta: plainMeta(Date.now() - startedAt),
          };
        }

        // Review time and neighbours are secondary; a failure in either must not lose the
        // risk score, so they run concurrently and independently.
        const warnings = risk.prediction.warnings ?? [];

        const [reviewTime, similar] = await Promise.all([
          this.ml.predictReviewTime({
            features: input.features,
            organizationId: ctx.organizationId,
          }),
          this.ml.similarPullRequests({
            features: input.features,
            k: 5,
            organizationId: ctx.organizationId,
          }),
        ]);

        const prediction = risk.prediction;

        const resolved = {
          response: prediction,
          reviewTimeMinutes: reviewTime?.minutes ?? null,
          reviewTimeRange: reviewTime
            ? { lower: reviewTime.lower_minutes, upper: reviewTime.upper_minutes }
            : null,
          similar: similar.map((neighbour) => ({
            reference: neighbour.reference,
            title: neighbour.title,
            similarity: neighbour.similarity,
            outcome: neighbour.outcome,
            riskScore: neighbour.risk_score,
          })),
          degradedReason: warnings.length > 0 ? warnings.join('; ') : null,
        };

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, { prediction: resolved });
        }

        return {
          output: {
            // A saturation or low-confidence warning is a degraded prediction, not a clean one.
            status: warnings.length > 0 ? ('DEGRADED' as const) : ('OK' as const),
            riskScore: prediction.risk_score,
            riskLevel: riskLevelFromScore(prediction.risk_score),
            probability: prediction.probability,
            confidence: prediction.confidence,
            isBaseline: prediction.is_baseline,
            topRiskReasons: prediction.top_risk_reasons,
            predictedReviewTimeMinutes: resolved.reviewTimeMinutes,
            reviewTimeRange: resolved.reviewTimeRange,
            similarPullRequests: resolved.similar,
            modelName: prediction.model_name,
            modelVersion: prediction.model_version,
            degradedReason: resolved.degradedReason,
          },
          meta: plainMeta(Date.now() - startedAt),
        };
      },
    });
  }

  // ================================================================ 6. retrieve_code_context

  private retrieveCodeContext() {
    return defineTool({
      name: ToolName.RETRIEVE_CODE_CONTEXT,
      description:
        'Retrieve existing repository code related to each changed file using hybrid ' +
        'vector, lexical, import-graph and convention search.',
      inputSchema: S.RetrieveCodeContextInput,
      outputSchema: S.RetrieveCodeContextOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: true,
      timeoutMs: 120_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();
        const state = ctx.reviewRunId ? this.scratchpad.require(ctx.reviewRunId) : null;
        const diff = state?.diff;

        if (!diff) {
          throw new Error('retrieve_code_context requires get_pr_diff to have run first');
        }

        const bundle = await this.rag.buildPrContext({
          organizationId: ctx.organizationId,
          repositoryId: input.repositoryId,
          files: diff.files
            .filter((file) => file.analyzable && file.patch)
            .map((file) => ({ filename: file.filename, patch: file.patch })),
          pullRequestTitle: diff.title,
          ...(input.maxTokensPerFile ? { maxTokensPerFile: input.maxTokensPerFile } : {}),
        });

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, { context: bundle });
        }

        const perFile: S.RetrieveCodeContextOutputType['perFile'] = {};
        let embeddingModel = 'none';

        for (const [path, result] of Object.entries(bundle.perFile)) {
          embeddingModel = result.embeddingModel;
          perFile[path] = {
            chunks: result.chunks,
            totalTokens: result.totalTokens,
            candidateCounts: result.candidateCounts,
            droppedForDiversity: result.droppedForDiversity,
            droppedForBudget: result.droppedForBudget,
            durationMs: result.durationMs,
          };
        }

        return {
          output: {
            perFile,
            repositoryOverview: bundle.repositoryOverview,
            totalTokens: bundle.totalTokens,
            filesWithContext: bundle.filesWithContext,
            filesWithoutContext: bundle.filesWithoutContext,
            embeddingModel,
          },
          meta: plainMeta(Date.now() - startedAt),
        };
      },
    });
  }

  // ================================================================ 7. generate_ai_review

  /**
   * Generate the AI review.
   *
   * The most security-sensitive tool, because it is the only one that sends repository content
   * to a third party. Three gates apply before any provider call:
   *
   *   1. If the organization has disabled external model calls, it refuses outright.
   *   2. If secrets were detected and policy says block, it refuses.
   *   3. Otherwise, if redaction is enabled, every detected secret is replaced in the diff
   *      before it is sent.
   */
  private generateAiReview() {
    return defineTool({
      name: ToolName.GENERATE_AI_REVIEW,
      description:
        'Generate a structured code review grounded in the diff, static analysis findings, ' +
        'ML risk prediction and retrieved repository context.',
      inputSchema: S.GenerateAiReviewInput,
      outputSchema: S.GenerateAiReviewOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: false,
      timeoutMs: 300_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();
        const state = ctx.reviewRunId ? this.scratchpad.require(ctx.reviewRunId) : null;
        const diff = state?.diff;

        if (!diff) {
          throw new Error('generate_ai_review requires get_pr_diff to have run first');
        }

        const emptyUsage = { prompt: 0, completion: 0, total: 0 };
        const skip = (reason: string) => ({
          output: {
            status: 'SKIPPED' as const,
            skippedReason: reason,
            review: null,
            effectiveRecommendation: null,
            policyOverridden: false,
            policyReasons: [],
            droppedFindingCount: 0,
            usedMapReduce: false,
            requiredRepair: false,
            provider: 'none',
            model: 'none',
            promptVersion: PROMPT_VERSION,
            tokenUsage: emptyUsage,
            costCents: 0,
            redactedBeforeSend: false,
          },
          meta: plainMeta(Date.now() - startedAt),
        });

        const [policy, aiSettings] = await Promise.all([
          this.policy.getPolicy(ctx.organizationId),
          this.policy.getAiSettings(ctx.organizationId),
        ]);

        // ---- gate 1: organization opt-out
        if (!aiSettings.allowExternalModelCalls) {
          ctx.logger.info('AI review skipped: organization disabled external model calls');
          return skip(
            'This organization has disabled external model calls, so no diff content is sent ' +
              'to a provider. Static analysis and ML risk are still available.',
          );
        }

        // ---- gate 2: secrets present and policy blocks
        const secrets = state?.staticAnalysis?.secretsDetected ?? [];

        if (secrets.length > 0 && policy.blockOnSecretDetection) {
          ctx.logger.warn('AI review blocked: secrets detected in the diff', {
            count: secrets.length,
          });

          return skip(
            `${secrets.length} possible secret(s) were detected in this diff. Under the ` +
              `organization's policy the diff is not sent to an AI provider until they are ` +
              `removed and rotated.`,
          );
        }

        const apiKey = this.config.ai.apiKeys[aiSettings.provider.toLowerCase() as
          | 'openai'
          | 'anthropic'
          | 'openrouter'];

        if (!apiKey) {
          ctx.logger.warn('AI review skipped: no provider API key configured');
          return skip(
            `No API key is configured for ${aiSettings.provider}. Set the corresponding ` +
              `environment variable to enable AI review. Static analysis and ML risk are ` +
              `unaffected.`,
          );
        }

        // ---- gate 3: redact before sending
        let redactedBeforeSend = false;

        const promptFiles = diff.files.map((file) => {
          let formatted = file.patch
            ? formatHunksForPrompt(parseUnifiedPatch(file.patch), { maxContextLines: 3 })
            : null;

          if (formatted && aiSettings.redactSecretsBeforeSend) {
            const result = redactSecrets(formatted);
            if (result.count > 0) {
              redactedBeforeSend = true;
              formatted = result.redacted;
            }
          }

          return {
            path: file.filename,
            status: file.status,
            language: file.language,
            flags: file.flags,
            additions: file.additions,
            deletions: file.deletions,
            diff: formatted,
          };
        });

        const provider = createProvider({
          provider: aiSettings.provider,
          model: aiSettings.model,
          apiKeys: this.config.ai.apiKeys,
          baseUrls: this.config.ai.baseUrls,
        });

        const generator = new ReviewGenerator({
          provider,
          logger: new NestToolLogger('ReviewGenerator', { traceId: ctx.traceId }),
          temperature: aiSettings.temperature,
          maxOutputTokens: aiSettings.maxOutputTokens,
        });

        const findings = (state?.staticAnalysis?.results ?? []).flatMap(
          (result) => result.findings,
        );

        const contextPerFile: Record<string, never[]> = {};
        const bundle = state?.context;

        const generated = await generator.generate(
          {
            pullRequest: {
              number: diff.number,
              title: diff.title,
              body: diff.body,
              authorLogin: diff.authorLogin,
              baseRef: diff.baseRef,
              headRef: diff.headRef,
              additions: diff.additions,
              deletions: diff.deletions,
              changedFiles: diff.changedFiles,
            },
            repository: {
              fullName: diff.repositoryFullName,
              primaryLanguage: state?.repoMetadata?.primaryLanguage ?? null,
              description: state?.repoMetadata?.description ?? null,
            },
            commitMessages: diff.commitMessages,
            files: promptFiles,
            findings,
            evidenceIds: input.evidenceIds,
            metrics: state?.metrics ?? null,
            risk: state?.prediction
              ? {
                  score: state.prediction.response.risk_score,
                  level: state.prediction.response.risk_level,
                  isBaseline: state.prediction.response.is_baseline,
                  confidence: state.prediction.response.confidence,
                  reasons: state.prediction.response.top_risk_reasons,
                  predictedReviewMinutes: state.prediction.reviewTimeMinutes,
                  similar: state.prediction.similar,
                }
              : null,
            contextPerFile: bundle
              ? Object.fromEntries(
                  Object.entries(bundle.perFile).map(([path, result]) => [path, result.chunks]),
                )
              : contextPerFile,
            repositoryOverview: bundle?.repositoryOverview ?? [],
            policy: {
              checklist: policy.checklist,
              blockingSeverity: policy.blockingSeverity,
              requireTestsForCodeChanges: policy.requireTestsForCodeChanges,
            },
            secretsDetected: secrets,
            wasRedacted: redactedBeforeSend,
          },
          {
            validEvidenceIds: new Set(input.validEvidenceIds),
            riskScore: state?.prediction?.response.risk_score ?? null,
            riskScoreGate: policy.riskScoreGate,
            blockingSeverity: policy.blockingSeverity,
            signal: ctx.signal,
          },
        );

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, {
            aiReview: {
              review: generated.review,
              effectiveRecommendation: generated.effectiveRecommendation,
              policyOverridden: generated.policyOverridden,
              policyReasons: generated.policyReasons,
              droppedFindingCount: generated.droppedFindings.length,
              usedMapReduce: generated.usedMapReduce,
              provider: aiSettings.provider,
              model: generated.model,
              promptVersion: PROMPT_VERSION,
              tokenUsage: {
                prompt: generated.usage.promptTokens,
                completion: generated.usage.completionTokens,
                total: generated.usage.totalTokens,
              },
              costCents: generated.costCents,
            },
            redactedBeforeSend,
          });
        }

        return {
          output: {
            status: 'OK' as const,
            skippedReason: null,
            review: generated.review,
            effectiveRecommendation: generated.effectiveRecommendation,
            policyOverridden: generated.policyOverridden,
            policyReasons: generated.policyReasons,
            droppedFindingCount: generated.droppedFindings.length,
            usedMapReduce: generated.usedMapReduce,
            requiredRepair: generated.requiredRepair,
            provider: aiSettings.provider,
            model: generated.model,
            promptVersion: PROMPT_VERSION,
            tokenUsage: {
              prompt: generated.usage.promptTokens,
              completion: generated.usage.completionTokens,
              total: generated.usage.totalTokens,
            },
            costCents: generated.costCents,
            redactedBeforeSend,
          },
          meta: {
            durationMs: Date.now() - startedAt,
            cacheHit: false,
            tokenUsage: {
              prompt: generated.usage.promptTokens,
              completion: generated.usage.completionTokens,
              total: generated.usage.totalTokens,
            },
            costCents: generated.costCents,
          },
        };
      },
    });
  }

  // ================================================================ 8. generate_test_suggestions

  private generateTestSuggestions() {
    return defineTool({
      name: ToolName.GENERATE_TEST_SUGGESTIONS,
      description:
        'Write runnable tests for the behaviours this pull request leaves uncovered, ' +
        "following the repository's existing test conventions.",
      inputSchema: S.GenerateTestSuggestionsInput,
      outputSchema: S.GenerateTestSuggestionsOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.NONE,
      modelInvocable: true,
      timeoutMs: 180_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();
        const state = ctx.reviewRunId ? this.scratchpad.require(ctx.reviewRunId) : null;

        const emptyUsage = { prompt: 0, completion: 0, total: 0 };
        const skip = (reason: string) => ({
          output: {
            status: 'SKIPPED' as const,
            skippedReason: reason,
            testCases: [],
            tokenUsage: emptyUsage,
            costCents: 0,
          },
          meta: plainMeta(Date.now() - startedAt),
        });

        const aiSettings = await this.policy.getAiSettings(ctx.organizationId);
        const apiKey = this.config.ai.apiKeys[aiSettings.provider.toLowerCase() as
          | 'openai'
          | 'anthropic'
          | 'openrouter'];

        if (!aiSettings.allowExternalModelCalls || !apiKey) {
          return skip('AI test generation is unavailable: no provider is configured or enabled');
        }

        // Prefer gaps the review identified; fall back to the caller's list.
        const missingTests = state?.aiReview?.review.missingTests ?? input.missingTests ?? [];

        if (missingTests.length === 0) {
          return skip('The review identified no uncovered behaviours, so no tests were generated');
        }

        const diff = state?.diff;
        if (!diff) return skip('No diff available');

        // Existing tests from the retrieved context, so generated tests match house style
        // rather than inventing a framework the repository does not use.
        const testExamples = Object.values(state?.context?.perFile ?? {})
          .flatMap((result) => result.chunks)
          .filter(
            (chunk) => chunk.kind === 'TEST_CASE' || /\.(test|spec)\./.test(chunk.path),
          )
          .slice(0, 4);

        const provider = createProvider({
          provider: aiSettings.provider,
          model: aiSettings.model,
          apiKeys: this.config.ai.apiKeys,
          baseUrls: this.config.ai.baseUrls,
        });

        const generator = new ReviewGenerator({
          provider,
          logger: new NestToolLogger('TestGenerator', { traceId: ctx.traceId }),
          temperature: aiSettings.temperature,
          maxOutputTokens: aiSettings.maxOutputTokens,
        });

        const result = await generator.generateTestSuggestions(
          {
            repository: {
              fullName: diff.repositoryFullName,
              primaryLanguage: state?.repoMetadata?.primaryLanguage ?? null,
            },
            pullRequestTitle: diff.title,
            missingTests,
            files: diff.files
              .filter((file) => file.patch && file.analyzable)
              .slice(0, 15)
              .map((file) => ({
                path: file.filename,
                diff: file.patch
                  ? formatHunksForPrompt(parseUnifiedPatch(file.patch), { maxContextLines: 2 })
                  : null,
              })),
            testExamples,
            framework: detectTestFramework(testExamples.map((chunk) => chunk.content)),
          },
          ctx.signal,
        );

        if (ctx.reviewRunId) {
          this.scratchpad.update(ctx.reviewRunId, { testSuggestions: result.testCases });
        }

        return {
          output: {
            status: 'OK' as const,
            skippedReason: null,
            testCases: result.testCases,
            tokenUsage: {
              prompt: result.usage.promptTokens,
              completion: result.usage.completionTokens,
              total: result.usage.totalTokens,
            },
            costCents: result.costCents,
          },
          meta: {
            durationMs: Date.now() - startedAt,
            cacheHit: false,
            tokenUsage: {
              prompt: result.usage.promptTokens,
              completion: result.usage.completionTokens,
              total: result.usage.totalTokens,
            },
            costCents: result.costCents,
          },
        };
      },
    });
  }

  // ================================================================ 9. create_review_report

  /**
   * Persist everything the run produced.
   *
   * The only tool that writes analysis artifacts, which keeps persistence in one reviewable
   * place and means every earlier tool is a pure function of its inputs. Writes are wrapped in
   * a transaction so a partially-saved report cannot be observed.
   */
  private createReviewReport() {
    return defineTool({
      name: ToolName.CREATE_REVIEW_REPORT,
      description:
        'Persist the findings, metrics, risk prediction, retrieved context and AI review ' +
        'produced by this run, and update the pull request summary.',
      inputSchema: S.CreateReviewReportInput,
      outputSchema: S.CreateReviewReportOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.INTERNAL_WRITE,
      modelInvocable: false,
      timeoutMs: 60_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();
        const state = this.scratchpad.require(input.reviewRunId);

        const result = await this.reportWriter.persist({
          organizationId: ctx.organizationId,
          reviewRunId: input.reviewRunId,
          pullRequestId: input.pullRequestId,
          state,
          // Findings cite the static analysis ToolRun as their provenance.
          staticAnalysisToolRunId: await this.findToolRunId(
            input.reviewRunId,
            ToolName.RUN_STATIC_ANALYSIS,
          ),
        });

        return { output: result, meta: plainMeta(Date.now() - startedAt) };
      },
    });
  }

  private async findToolRunId(reviewRunId: string, tool: ToolName): Promise<string | null> {
    const row = await this.prisma.unscoped.toolRun.findFirst({
      where: { reviewRunId, tool, status: 'SUCCESS' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  // ================================================================ 10. post_github_comment

  /**
   * Publish the review summary to the GitHub pull request.
   *
   * The only tool with external write access, so it carries the strictest controls: a REVIEWER
   * role minimum, an explicit organization policy opt-in, and a hard block on dry runs enforced
   * by the registry rather than by this code.
   */
  private postGithubComment() {
    return defineTool({
      name: ToolName.POST_GITHUB_COMMENT,
      description:
        'Post or update the CodeLens review summary as a comment on the GitHub pull request.',
      inputSchema: S.PostGithubCommentToolInput,
      outputSchema: S.PostGithubCommentToolOutput,
      // Writing to a customer's GitHub repository is a reviewer-level action.
      requiredRole: Role.REVIEWER,
      sideEffects: ToolSideEffect.EXTERNAL_WRITE,
      modelInvocable: false,
      timeoutMs: 60_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();
        const state = this.scratchpad.require(input.reviewRunId);
        const policy = await this.policy.getPolicy(ctx.organizationId);

        if (!roleAtLeast(ctx.userRole, policy.githubCommentMinRole)) {
          throw new PolicyViolationError(
            `Posting to GitHub requires the ${policy.githubCommentMinRole} role under this ` +
              `organization's policy; the caller has ${ctx.userRole}.`,
          );
        }

        const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
          where: { id: input.pullRequestId, organizationId: ctx.organizationId },
          include: { repository: { select: { id: true, fullName: true } } },
        });

        if (!pullRequest) {
          throw new Error(`Pull request ${input.pullRequestId} not found in this organization`);
        }

        const body = this.reportWriter.renderGithubComment({
          state,
          options: input,
          webUrl: this.config.webUrl,
          pullRequestId: input.pullRequestId,
        });

        if (!body) {
          return {
            output: {
              status: 'SKIPPED' as const,
              skippedReason: 'There is no completed AI review to publish',
              commentId: null,
              htmlUrl: null,
            },
            meta: plainMeta(Date.now() - startedAt),
          };
        }

        const { client, actingLogin } = await this.github.forRepository({
          repositoryId: pullRequest.repositoryId,
          organizationId: ctx.organizationId,
          preferUserId: ctx.userId,
        });

        const result = await client.upsertIssueComment(
          pullRequest.repository.fullName,
          pullRequest.number,
          body,
          'codelens-review',
        );

        await this.audit.record({
          organizationId: ctx.organizationId,
          action: AuditAction.GITHUB_COMMENT_POSTED,
          actorId: ctx.userId,
          resourceType: 'PullRequest',
          resourceId: input.pullRequestId,
          description:
            `${result.updated ? 'Updated' : 'Posted'} the CodeLens review comment on ` +
            `${pullRequest.repository.fullName}#${pullRequest.number}` +
            (actingLogin ? ` using @${actingLogin}'s GitHub connection` : ''),
          metadata: { commentId: result.commentId, updated: result.updated },
          traceId: ctx.traceId,
        });

        return {
          output: {
            status: result.updated ? ('UPDATED' as const) : ('POSTED' as const),
            skippedReason: null,
            commentId: result.commentId,
            htmlUrl: result.htmlUrl,
          },
          meta: plainMeta(Date.now() - startedAt),
        };
      },
    });
  }

  // ================================================================ 11. create_audit_log

  private createAuditLog() {
    return defineTool({
      name: ToolName.CREATE_AUDIT_LOG,
      description: 'Record an entry in the organization audit trail.',
      inputSchema: S.CreateAuditLogInput,
      outputSchema: S.CreateAuditLogOutput,
      requiredRole: Role.DEVELOPER,
      sideEffects: ToolSideEffect.INTERNAL_WRITE,
      modelInvocable: false,
      timeoutMs: 15_000,
      execute: async (input, ctx) => {
        const startedAt = Date.now();

        await this.audit.record({
          organizationId: ctx.organizationId,
          action: input.action,
          actorId: ctx.userId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          description: input.description,
          metadata: input.metadata as Record<string, unknown>,
          traceId: ctx.traceId,
        });

        return { output: { recorded: true }, meta: plainMeta(Date.now() - startedAt) };
      },
    });
  }
}

/** Identify the test framework from example test content, to keep generated tests idiomatic. */
function detectTestFramework(samples: string[]): string | null {
  const joined = samples.join('\n').toLowerCase();

  if (joined.includes('from vitest') || joined.includes("'vitest'")) return 'vitest';
  if (joined.includes('@jest/globals') || joined.includes('jest.mock')) return 'jest';
  if (joined.includes('import pytest') || joined.includes('def test_')) return 'pytest';
  if (joined.includes('@testing-library')) return 'jest + testing-library';
  if (joined.includes('describe(') && joined.includes('it(')) return 'jest or vitest';
  if (joined.includes('func test')) return 'go test';

  return null;
}

export { toErrorMessage };
