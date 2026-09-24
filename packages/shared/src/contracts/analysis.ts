import { z } from 'zod';
import {
  Analyzer,
  AnalyzerStatus,
  FindingCategory,
  ReviewRunStatus,
  ReviewStage,
  Severity,
  ToolName,
  ToolRunStatus,
} from '../enums';
import { IdSchema, type JsonValue } from './common';

// ---------------------------------------------------------------- static findings

export interface StaticFinding {
  id: string;
  analyzer: Analyzer;
  ruleId: string;
  severity: Severity;
  category: FindingCategory;
  message: string;
  /** Null for repo-level findings such as a vulnerable transitive dependency. */
  path: string | null;
  line: number | null;
  endLine: number | null;
  column: number | null;
  /** Rule documentation URL when the analyzer provides one. */
  helpUrl: string | null;
  /** Source line(s) the finding refers to, for display without refetching. */
  snippet: string | null;
  /**
   * Stable hash of (analyzer, ruleId, path, normalized message). Lets us
   * deduplicate across runs and recognise a finding the team already dismissed.
   */
  fingerprint: string;
  /**
   * True when the finding sits on a line the PR did not touch. Shown separately
   * and excluded from `security_findings_count` so authors are not charged for
   * inherited debt.
   */
  preexisting: boolean;
  /** The ToolRun that produced this finding. The audit trail depends on it. */
  sourceToolRunId: string;
}

export interface AnalyzerResult {
  analyzer: Analyzer;
  status: AnalyzerStatus;
  findings: StaticFinding[];
  durationMs: number;
  /** Populated when status is FAILED, TIMED_OUT or NOT_INSTALLED. */
  error: string | null;
  /** Analyzer version, recorded so results stay interpretable over time. */
  version: string | null;
  filesAnalyzed: number;
}

/** Objective size and shape metrics. No model involved. */
export interface PrMetricsView {
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  commitCount: number;
  functionsChanged: number;
  complexityBefore: number;
  complexityAfter: number;
  complexityDelta: number;
  /** Highest cyclomatic complexity of any single changed function. */
  maxFunctionComplexity: number;
  /**
   * CRITICAL + HIGH security findings on lines this PR touched.
   *
   * Populated after the analyzers run, since it depends on their output, but it
   * lives here because the ML feature vector treats it as a metric.
   */
  securityFindingsCount: number;
  testFilesChanged: number;
  hasTests: boolean;
  dependencyChanged: boolean;
  authFileChanged: boolean;
  databaseFileChanged: boolean;
  configFileChanged: boolean;
  paymentFileChanged: boolean;
  infraFileChanged: boolean;
  previousRiskyFileCount: number;
  /** Ratio of test lines to non-test lines in the diff. */
  testToCodeRatio: number;
}

export interface StaticAnalysisSummary {
  results: AnalyzerResult[];
  metrics: PrMetricsView;
  totalFindings: number;
  newFindings: number;
  preexistingFindings: number;
  countsBySeverity: Record<Severity, number>;
  countsByCategory: Record<FindingCategory, number>;
  /** Secret scan outcome. A hit blocks the LLM call under default policy. */
  secretsDetected: Array<{ path: string; line: number; kind: string }>;
}

// ---------------------------------------------------------------- tool runs

/**
 * One MCP-style tool invocation. These rows are the audit spine of the agent:
 * every AI finding references the ToolRun that produced its evidence, and the
 * RAG viewer and report pages render straight from here.
 */
export interface ToolRunView {
  id: string;
  tool: ToolName;
  status: ToolRunStatus;
  sequence: number;
  input: JsonValue;
  /** Null while running, or when the tool failed. */
  output: JsonValue | null;
  error: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string | null;
  /** Populated for tools that call an LLM. */
  tokenUsage: { prompt: number; completion: number; total: number } | null;
  costCents: number | null;
  /** True when a cached result was reused instead of re-executing. */
  cacheHit: boolean;
}

// ---------------------------------------------------------------- review runs

export const TriggerReviewRunSchema = z.object({
  pullRequestId: IdSchema,
  /**
   * Skip the idempotency check and force a fresh run. Used when a reviewer wants
   * a re-analysis after changing org policy.
   */
  force: z.boolean().default(false),
  /** Publish the AI summary to GitHub when the run finishes. */
  postToGithub: z.boolean().default(false),
  /** Subset of stages to run; defaults to the full pipeline. */
  stages: z.array(z.nativeEnum(ReviewStage)).optional(),
});
export type TriggerReviewRunInput = z.infer<typeof TriggerReviewRunSchema>;

export interface ReviewRunView {
  id: string;
  pullRequestId: string;
  status: ReviewRunStatus;
  stage: ReviewStage;
  /** 0-100, derived from stage position. Drives the progress bar. */
  progress: number;
  triggeredByUserId: string | null;
  triggeredBy: 'USER' | 'WEBHOOK' | 'SCHEDULE' | 'API';
  /** Head SHA analysed. A new commit invalidates the run. */
  headSha: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokenUsage: { prompt: number; completion: number; total: number } | null;
  costCents: number;
  promptVersion: string;
  featureSchemaVersion: number;
  toolRuns: ToolRunView[];
  /** Which optional layers actually produced results this run. */
  capabilities: {
    staticAnalysis: boolean;
    mlRisk: boolean;
    ragContext: boolean;
    aiReview: boolean;
  };
}

export function reviewRunProgress(stage: ReviewStage, order: readonly ReviewStage[]): number {
  const index = order.indexOf(stage);
  if (index < 0) return 0;
  return Math.round((index / (order.length - 1)) * 100);
}
