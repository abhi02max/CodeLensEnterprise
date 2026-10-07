import { z } from 'zod';
import {
  AiReviewSchema,
  ChunkKind,
  FindingCategory,
  PostGithubCommentSchema,
  PrFeaturesSchema,
  RetrievalSource,
  RiskReasonSchema,
  Severity,
  SuggestedTestCaseSchema,
} from '@codelens/shared';

/**
 * Input and output schemas for the eleven MCP tools.
 *
 * Kept in one file because they form a single contract surface: the orchestrator composes
 * one tool's output into the next tool's input, and having the whole chain visible in one
 * place is what makes that composition reviewable.
 *
 * Every schema is enforced twice by McpToolRegistry — input before execution, output after.
 * The output half is the unusual one and it is deliberate: it catches an upstream contract
 * drift (a changed ML response, a changed GitHub payload) at the boundary rather than three
 * stages later where the cause is no longer obvious.
 */

// ---------------------------------------------------------------- shared shapes

const PullRequestRef = z.object({
  pullRequestId: z.string().min(1),
});

/** Every tool is explicitly scoped. Passing the org id rather than reading it from
 *  ambient state means a tool cannot accidentally run unscoped. */
const OrgScoped = z.object({
  organizationId: z.string().min(1),
});

// ---------------------------------------------------------------- get_pr_diff

/**
 * Note on the absence of `.default()` below.
 *
 * A Zod default makes a schema's input and output types differ, and `McpTool` is declared as
 * `inputSchema: z.ZodType<I>`, which binds `I` to the input side. Every defaulted field would
 * therefore reach a tool body as `T | undefined` despite Zod having filled it in. The pipeline
 * assembles these inputs explicitly in `AnalysisService.buildToolInput`, so requiring the
 * fields is both simpler and better typed.
 */

export const GetPrDiffInput = PullRequestRef.extend({
  /** Re-fetch from GitHub even if a diff is already stored. */
  refresh: z.boolean(),
});

export const GetPrDiffOutput = z.object({
  pullRequestId: z.string(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  authorLogin: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
  diffRevision: z
    .object({
      provenance: z.enum(['VERIFIED', 'UNVERIFIED']),
      baseSha: z.string().nullable(),
      headSha: z.string().nullable(),
      mergeBaseSha: z.string().nullable(),
      fileSet: z.enum(['COMPLETE', 'PARTIAL', 'UNVERIFIED']),
      patches: z.enum(['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'UNVERIFIED']),
    })
    .optional(),
  headRef: z.string(),
  baseRef: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  commitMessages: z.array(z.string()),
  files: z.array(
    z.object({
      filename: z.string(),
      status: z.string(),
      language: z.string(),
      flags: z.array(z.string()),
      additions: z.number().int(),
      deletions: z.number().int(),
      patch: z.string().nullable(),
      patchTruncated: z.boolean(),
      binary: z.boolean(),
      analyzable: z.boolean(),
      touchedLines: z.array(z.number().int()),
    }),
  ),
});

// ---------------------------------------------------------------- get_repo_metadata

export const GetRepoMetadataInput = z.object({
  repositoryId: z.string().min(1),
});

export const GetRepoMetadataOutput = z.object({
  repositoryId: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  primaryLanguage: z.string().nullable(),
  description: z.string().nullable(),
  private: z.boolean(),
  /** Drives the RETRIEVE_CODE_CONTEXT pipeline condition. */
  indexed: z.boolean(),
  indexedChunkCount: z.number().int(),
  indexedAt: z.string().nullable(),
  /** Config files present at the repo root, so analyzers know what they can run. */
  repoConfigFiles: z.array(z.string()),
  /** Historically troublesome paths, feeding previous_risky_file_count. */
  riskyPaths: z.array(z.string()),
});

// ---------------------------------------------------------------- run_static_analysis

export const RunStaticAnalysisInput = PullRequestRef.extend({
  repositoryId: z.string().min(1),
});

export const StaticFindingOutput = z.object({
  analyzer: z.string(),
  ruleId: z.string(),
  severity: z.nativeEnum(Severity),
  category: z.nativeEnum(FindingCategory),
  message: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  column: z.number().int().nullable(),
  helpUrl: z.string().nullable(),
  snippet: z.string().nullable(),
  fingerprint: z.string(),
  preexisting: z.boolean(),
});

export const RunStaticAnalysisOutput = z.object({
  analyzers: z.array(
    z.object({
      analyzer: z.string(),
      status: z.string(),
      findingCount: z.number().int(),
      durationMs: z.number(),
      error: z.string().nullable(),
      filesAnalyzed: z.number().int(),
    }),
  ),
  findings: z.array(StaticFindingOutput),
  totalFindings: z.number().int(),
  newFindings: z.number().int(),
  preexistingFindings: z.number().int(),
  countsBySeverity: z.record(z.number().int()),
  /** Masked. The secret value itself is never in a tool output. */
  secretsDetected: z.array(
    z.object({ path: z.string(), line: z.number().int(), kind: z.string() }),
  ),
  metrics: z.object({
    linesAdded: z.number().int(),
    linesDeleted: z.number().int(),
    filesChanged: z.number().int(),
    functionsChanged: z.number().int(),
    complexityBefore: z.number(),
    complexityAfter: z.number(),
    complexityDelta: z.number(),
    maxFunctionComplexity: z.number(),
    securityFindingsCount: z.number().int(),
    testFilesChanged: z.number().int(),
    hasTests: z.boolean(),
    testToCodeRatio: z.number(),
    dependencyChanged: z.boolean(),
    authFileChanged: z.boolean(),
    databaseFileChanged: z.boolean(),
    configFileChanged: z.boolean(),
    paymentFileChanged: z.boolean(),
    infraFileChanged: z.boolean(),
  }),
});

// ---------------------------------------------------------------- extract_ml_features

export const ExtractMlFeaturesInput = PullRequestRef.extend({
  repositoryId: z.string().min(1),
});

export const ExtractMlFeaturesOutput = z.object({
  features: PrFeaturesSchema,
  featureSchemaVersion: z.number().int(),
  /** True when static analysis did not run, so finding counts are zeroed. */
  degraded: z.boolean(),
  degradedReason: z.string().nullable(),
});

// ---------------------------------------------------------------- predict_pr_risk

export const PredictPrRiskInput = OrgScoped.extend({
  features: PrFeaturesSchema,
  includeExplanation: z.boolean(),
});

export const PredictPrRiskOutput = z.object({
  status: z.enum(['OK', 'UNAVAILABLE', 'DEGRADED']),
  riskScore: z.number().min(0).max(100),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  isBaseline: z.boolean(),
  topRiskReasons: z.array(RiskReasonSchema),
  predictedReviewTimeMinutes: z.number().nullable(),
  reviewTimeRange: z.object({ lower: z.number(), upper: z.number() }).nullable(),
  similarPullRequests: z.array(
    z.object({
      reference: z.string(),
      title: z.string(),
      similarity: z.number(),
      outcome: z.string(),
      riskScore: z.number(),
    }),
  ),
  modelName: z.string(),
  modelVersion: z.string(),
  degradedReason: z.string().nullable(),
});

// ---------------------------------------------------------------- retrieve_code_context

export const RetrieveCodeContextInput = z.object({
  repositoryId: z.string().min(1),
  pullRequestId: z.string().min(1),
  maxTokensPerFile: z.number().int().min(256).max(16_000).optional(),
});

const RetrievedChunkOutput = z.object({
  chunkId: z.string(),
  path: z.string(),
  symbol: z.string().nullable(),
  kind: z.nativeEnum(ChunkKind),
  language: z.string(),
  content: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  tokenCount: z.number().int(),
  score: z.number(),
  vectorScore: z.number().nullable(),
  lexicalScore: z.number().nullable(),
  sources: z.array(z.nativeEnum(RetrievalSource)),
  rationale: z.string(),
});

export const RetrieveCodeContextOutput = z.object({
  perFile: z.record(
    z.object({
      chunks: z.array(RetrievedChunkOutput),
      totalTokens: z.number().int(),
      candidateCounts: z.record(z.number().int()),
      droppedForDiversity: z.number().int(),
      droppedForBudget: z.number().int(),
      durationMs: z.number(),
    }),
  ),
  repositoryOverview: z.array(RetrievedChunkOutput),
  totalTokens: z.number().int(),
  filesWithContext: z.number().int(),
  filesWithoutContext: z.array(z.string()),
  embeddingModel: z.string(),
});

// ---------------------------------------------------------------- generate_ai_review

export const GenerateAiReviewInput = z.object({
  pullRequestId: z.string().min(1),
  repositoryId: z.string().min(1),
  /** ToolRun ids the model may cite. Findings citing anything else are dropped. */
  validEvidenceIds: z.array(z.string()),
  /** Maps analyzer name to the ToolRun id that produced it, for the prompt. */
  evidenceIds: z.record(z.string()),
});

export const GenerateAiReviewOutput = z.object({
  status: z.enum(['OK', 'SKIPPED']),
  skippedReason: z.string().nullable(),
  review: AiReviewSchema.nullable(),
  effectiveRecommendation: z.enum(['APPROVE', 'REQUEST_CHANGES', 'NEEDS_DISCUSSION']).nullable(),
  policyOverridden: z.boolean(),
  policyReasons: z.array(z.string()),
  droppedFindingCount: z.number().int(),
  usedMapReduce: z.boolean(),
  requiredRepair: z.boolean(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  tokenUsage: z.object({
    prompt: z.number().int(),
    completion: z.number().int(),
    total: z.number().int(),
  }),
  costCents: z.number().int(),
  /** True when detected secrets were redacted before the provider call. */
  redactedBeforeSend: z.boolean(),
});

// ---------------------------------------------------------------- generate_test_suggestions

export const GenerateTestSuggestionsInput = z.object({
  pullRequestId: z.string().min(1),
  repositoryId: z.string().min(1),
  missingTests: z.array(z.string()),
});

export const GenerateTestSuggestionsOutput = z.object({
  status: z.enum(['OK', 'SKIPPED']),
  skippedReason: z.string().nullable(),
  testCases: z.array(SuggestedTestCaseSchema),
  tokenUsage: z.object({
    prompt: z.number().int(),
    completion: z.number().int(),
    total: z.number().int(),
  }),
  costCents: z.number().int(),
});

// ---------------------------------------------------------------- create_review_report

export const CreateReviewReportInput = z.object({
  reviewRunId: z.string().min(1),
  pullRequestId: z.string().min(1),
});

export const CreateReviewReportOutput = z.object({
  reviewRunId: z.string(),
  pullRequestId: z.string(),
  findingsPersisted: z.number().int(),
  metricsPersisted: z.boolean(),
  predictionPersisted: z.boolean(),
  aiReviewPersisted: z.boolean(),
  contextChunksPersisted: z.number().int(),
  riskScore: z.number().nullable(),
  riskLevel: z.string().nullable(),
});

// ---------------------------------------------------------------- post_github_comment

/**
 * Declared explicitly rather than extending PostGithubCommentSchema, whose fields carry
 * defaults. The HTTP-facing schema keeps its defaults for ergonomics; the tool contract requires
 * every field so the tool body receives fully-resolved options.
 */
export const PostGithubCommentToolInput = z.object({
  pullRequestId: z.string().min(1),
  reviewRunId: z.string().min(1),
  includeFileBreakdown: z.boolean(),
  includeRiskScore: z.boolean(),
  includeChecklist: z.boolean(),
  minSeverity: z.nativeEnum(Severity),
  categories: z.array(z.nativeEnum(FindingCategory)),
});

export const PostGithubCommentToolOutput = z.object({
  status: z.enum(['POSTED', 'UPDATED', 'SKIPPED']),
  skippedReason: z.string().nullable(),
  commentId: z.number().int().nullable(),
  htmlUrl: z.string().nullable(),
});

// ---------------------------------------------------------------- create_audit_log

export const CreateAuditLogInput = z.object({
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullable(),
  description: z.string().min(1),
  metadata: z.record(z.unknown()),
});

export const CreateAuditLogOutput = z.object({
  recorded: z.boolean(),
});

// ---------------------------------------------------------------- inferred types

export type GetPrDiffOutputType = z.infer<typeof GetPrDiffOutput>;
export type GetRepoMetadataOutputType = z.infer<typeof GetRepoMetadataOutput>;
export type RunStaticAnalysisOutputType = z.infer<typeof RunStaticAnalysisOutput>;
export type ExtractMlFeaturesOutputType = z.infer<typeof ExtractMlFeaturesOutput>;
export type PredictPrRiskOutputType = z.infer<typeof PredictPrRiskOutput>;
export type RetrieveCodeContextOutputType = z.infer<typeof RetrieveCodeContextOutput>;
export type GenerateAiReviewOutputType = z.infer<typeof GenerateAiReviewOutput>;
export type GenerateTestSuggestionsOutputType = z.infer<typeof GenerateTestSuggestionsOutput>;
export type CreateReviewReportOutputType = z.infer<typeof CreateReviewReportOutput>;
export type PostGithubCommentToolOutputType = z.infer<typeof PostGithubCommentToolOutput>;
