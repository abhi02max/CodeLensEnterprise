/**
 * Domain enums.
 *
 * These are declared as const objects + derived union types rather than TS
 * `enum`s so the exact same literals can be reused as Zod enum members, as
 * Prisma enum values, and as JSON over the wire without any conversion layer.
 */

// ---------------------------------------------------------------- access control

export const Role = {
  DEVELOPER: 'DEVELOPER',
  REVIEWER: 'REVIEWER',
  ADMIN: 'ADMIN',
  OWNER: 'OWNER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/**
 * Privilege ordering. Guards compare numeric rank rather than doing set
 * membership checks, so `requiredRole: REVIEWER` transparently admits ADMIN
 * and OWNER without every call site listing them.
 */
export const ROLE_RANK: Record<Role, number> = {
  DEVELOPER: 10,
  REVIEWER: 20,
  ADMIN: 30,
  OWNER: 40,
};

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ---------------------------------------------------------------- risk

export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const Severity = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 50,
  HIGH: 40,
  MEDIUM: 30,
  LOW: 20,
  INFO: 10,
};

export function severityAtLeast(actual: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[threshold];
}

// ---------------------------------------------------------------- findings

export const FindingCategory = {
  BUG: 'BUG',
  SECURITY: 'SECURITY',
  PERFORMANCE: 'PERFORMANCE',
  MAINTAINABILITY: 'MAINTAINABILITY',
  TESTING: 'TESTING',
  STYLE: 'STYLE',
  DEPENDENCY: 'DEPENDENCY',
  TYPE_SAFETY: 'TYPE_SAFETY',
} as const;
export type FindingCategory = (typeof FindingCategory)[keyof typeof FindingCategory];

/**
 * Categories for which the agent must supply backing evidence. A finding in one
 * of these buckets with an empty `evidence[]` is discarded during validation —
 * this is the single most effective hallucination control in the pipeline.
 */
export const EVIDENCE_REQUIRED_CATEGORIES: readonly FindingCategory[] = [
  FindingCategory.SECURITY,
  FindingCategory.DEPENDENCY,
];

export const Analyzer = {
  ESLINT: 'ESLINT',
  SEMGREP: 'SEMGREP',
  NPM_AUDIT: 'NPM_AUDIT',
  TSC: 'TSC',
  METRICS: 'METRICS',
  SECRET_SCAN: 'SECRET_SCAN',
  /**
   * Built-in, dependency-free pattern analyzer.
   *
   * Distinct from SEMGREP because it has different capabilities and a different trust profile: it
   * works on content reconstructed from diff hunks, where an AST-based analyzer cannot parse, but
   * it has no dataflow analysis. Findings should be attributable to the engine that produced them.
   */
  PATTERN_SCAN: 'PATTERN_SCAN',
} as const;
export type Analyzer = (typeof Analyzer)[keyof typeof Analyzer];

export const AnalyzerStatus = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  TIMED_OUT: 'TIMED_OUT',
  NOT_INSTALLED: 'NOT_INSTALLED',
} as const;
export type AnalyzerStatus = (typeof AnalyzerStatus)[keyof typeof AnalyzerStatus];

// ---------------------------------------------------------------- review lifecycle

export const ReviewRunStatus = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PARTIAL: 'PARTIAL',
} as const;
export type ReviewRunStatus = (typeof ReviewRunStatus)[keyof typeof ReviewRunStatus];

/**
 * Pipeline stages, in execution order. Surfaced verbatim in the UI progress
 * indicator, so the order here is the order the user sees.
 */
export const ReviewStage = {
  PENDING: 'PENDING',
  FETCHING_DIFF: 'FETCHING_DIFF',
  STATIC_ANALYSIS: 'STATIC_ANALYSIS',
  FEATURE_EXTRACTION: 'FEATURE_EXTRACTION',
  RISK_PREDICTION: 'RISK_PREDICTION',
  CONTEXT_RETRIEVAL: 'CONTEXT_RETRIEVAL',
  AI_REVIEW: 'AI_REVIEW',
  TEST_SUGGESTIONS: 'TEST_SUGGESTIONS',
  REPORT_ASSEMBLY: 'REPORT_ASSEMBLY',
  PUBLISHING: 'PUBLISHING',
  DONE: 'DONE',
} as const;
export type ReviewStage = (typeof ReviewStage)[keyof typeof ReviewStage];

export const REVIEW_STAGE_ORDER: readonly ReviewStage[] = [
  ReviewStage.PENDING,
  ReviewStage.FETCHING_DIFF,
  ReviewStage.STATIC_ANALYSIS,
  ReviewStage.FEATURE_EXTRACTION,
  ReviewStage.RISK_PREDICTION,
  ReviewStage.CONTEXT_RETRIEVAL,
  ReviewStage.AI_REVIEW,
  ReviewStage.TEST_SUGGESTIONS,
  ReviewStage.REPORT_ASSEMBLY,
  ReviewStage.PUBLISHING,
  ReviewStage.DONE,
];

export const ReviewVerdict = {
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  NEEDS_DISCUSSION: 'NEEDS_DISCUSSION',
} as const;
export type ReviewVerdict = (typeof ReviewVerdict)[keyof typeof ReviewVerdict];

export const ApprovalRecommendation = {
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  NEEDS_DISCUSSION: 'NEEDS_DISCUSSION',
} as const;
export type ApprovalRecommendation =
  (typeof ApprovalRecommendation)[keyof typeof ApprovalRecommendation];

export const CommentOrigin = {
  HUMAN: 'HUMAN',
  AI: 'AI',
} as const;
export type CommentOrigin = (typeof CommentOrigin)[keyof typeof CommentOrigin];

// ---------------------------------------------------------------- pull requests

export const PullRequestState = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  MERGED: 'MERGED',
  DRAFT: 'DRAFT',
} as const;
export type PullRequestState = (typeof PullRequestState)[keyof typeof PullRequestState];

export const FileChangeStatus = {
  ADDED: 'ADDED',
  MODIFIED: 'MODIFIED',
  REMOVED: 'REMOVED',
  RENAMED: 'RENAMED',
  COPIED: 'COPIED',
  CHANGED: 'CHANGED',
  UNCHANGED: 'UNCHANGED',
} as const;
export type FileChangeStatus = (typeof FileChangeStatus)[keyof typeof FileChangeStatus];

/**
 * Semantic tags applied to each changed file by the classifier. They drive both
 * ML features and policy rules ("PRs touching auth always need two reviewers").
 */
export const FileFlag = {
  TEST: 'TEST',
  DEPENDENCY: 'DEPENDENCY',
  AUTH: 'AUTH',
  DATABASE: 'DATABASE',
  CONFIG: 'CONFIG',
  PAYMENT: 'PAYMENT',
  INFRA: 'INFRA',
  CI: 'CI',
  DOCS: 'DOCS',
  GENERATED: 'GENERATED',
  MIGRATION: 'MIGRATION',
  API_SURFACE: 'API_SURFACE',
} as const;
export type FileFlag = (typeof FileFlag)[keyof typeof FileFlag];

// ---------------------------------------------------------------- rag

export const ChunkKind = {
  FILE: 'FILE',
  FUNCTION: 'FUNCTION',
  CLASS: 'CLASS',
  METHOD: 'METHOD',
  INTERFACE: 'INTERFACE',
  ROUTE: 'ROUTE',
  SCHEMA_MODEL: 'SCHEMA_MODEL',
  TEST_CASE: 'TEST_CASE',
  DOC_SECTION: 'DOC_SECTION',
  CONFIG_BLOCK: 'CONFIG_BLOCK',
} as const;
export type ChunkKind = (typeof ChunkKind)[keyof typeof ChunkKind];

/** Which retrieval strategy surfaced a chunk. Rendered in the RAG viewer. */
export const RetrievalSource = {
  VECTOR: 'VECTOR',
  LEXICAL: 'LEXICAL',
  IMPORT_GRAPH: 'IMPORT_GRAPH',
  CONVENTION: 'CONVENTION',
} as const;
export type RetrievalSource = (typeof RetrievalSource)[keyof typeof RetrievalSource];

export const IndexStatus = {
  NOT_INDEXED: 'NOT_INDEXED',
  QUEUED: 'QUEUED',
  INDEXING: 'INDEXING',
  INDEXED: 'INDEXED',
  FAILED: 'FAILED',
  STALE: 'STALE',
} as const;
export type IndexStatus = (typeof IndexStatus)[keyof typeof IndexStatus];

// ---------------------------------------------------------------- ai / ml

export const AiProvider = {
  OPENAI: 'OPENAI',
  ANTHROPIC: 'ANTHROPIC',
  OPENROUTER: 'OPENROUTER',
} as const;
export type AiProvider = (typeof AiProvider)[keyof typeof AiProvider];

export const MlStatus = {
  OK: 'OK',
  UNAVAILABLE: 'UNAVAILABLE',
  DEGRADED: 'DEGRADED',
} as const;
export type MlStatus = (typeof MlStatus)[keyof typeof MlStatus];

// ---------------------------------------------------------------- tooling

/**
 * MCP-style tool names. This union is the single source of truth: the registry
 * is keyed by it, `ToolRun.tool` stores it, and the UI maps it to labels.
 */
export const ToolName = {
  GET_PR_DIFF: 'get_pr_diff',
  GET_REPO_METADATA: 'get_repo_metadata',
  RUN_STATIC_ANALYSIS: 'run_static_analysis',
  EXTRACT_ML_FEATURES: 'extract_ml_features',
  PREDICT_PR_RISK: 'predict_pr_risk',
  RETRIEVE_CODE_CONTEXT: 'retrieve_code_context',
  GENERATE_AI_REVIEW: 'generate_ai_review',
  GENERATE_TEST_SUGGESTIONS: 'generate_test_suggestions',
  CREATE_REVIEW_REPORT: 'create_review_report',
  POST_GITHUB_COMMENT: 'post_github_comment',
  CREATE_AUDIT_LOG: 'create_audit_log',
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const ToolRunStatus = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  TIMED_OUT: 'TIMED_OUT',
} as const;
export type ToolRunStatus = (typeof ToolRunStatus)[keyof typeof ToolRunStatus];

/** Tools that mutate systems outside CodeLens require extra authorization. */
export const ToolSideEffect = {
  NONE: 'none',
  INTERNAL_WRITE: 'internal-write',
  EXTERNAL_WRITE: 'external-write',
} as const;
export type ToolSideEffect = (typeof ToolSideEffect)[keyof typeof ToolSideEffect];

// ---------------------------------------------------------------- audit

export const AuditAction = {
  USER_SIGNED_UP: 'user.signed_up',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGGED_OUT: 'user.logged_out',
  GITHUB_CONNECTED: 'github.connected',
  GITHUB_DISCONNECTED: 'github.disconnected',
  ORG_CREATED: 'org.created',
  ORG_UPDATED: 'org.updated',
  MEMBER_INVITED: 'member.invited',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',
  REPO_CONNECTED: 'repo.connected',
  REPO_DISCONNECTED: 'repo.disconnected',
  REPO_INDEX_STARTED: 'repo.index_started',
  REPO_INDEX_COMPLETED: 'repo.index_completed',
  PR_SYNCED: 'pr.synced',
  REVIEW_RUN_STARTED: 'review_run.started',
  REVIEW_RUN_COMPLETED: 'review_run.completed',
  REVIEW_RUN_FAILED: 'review_run.failed',
  REVIEW_SUBMITTED: 'review.submitted',
  COMMENT_CREATED: 'comment.created',
  COMMENT_UPDATED: 'comment.updated',
  COMMENT_DELETED: 'comment.deleted',
  COMMENT_RESOLVED: 'comment.resolved',
  COMMENT_REOPENED: 'comment.reopened',
  SHARE_LINK_CREATED: 'share_link.created',
  SHARE_LINK_REVOKED: 'share_link.revoked',
  /**
   * Recorded on every successful anonymous view of a share link.
   *
   * Worth auditing specifically because it is the only way data leaves the tenant
   * without an authenticated actor: if a link is forwarded outside the company, the
   * view count and these entries are the only trace of it.
   */
  SHARE_LINK_VIEWED: 'share_link.viewed',
  GITHUB_COMMENT_POSTED: 'github.comment_posted',
  POLICY_UPDATED: 'policy.updated',
  SETTINGS_UPDATED: 'settings.updated',
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  TOOL_EXECUTED: 'tool.executed',
  PATCH_PROPOSED: 'collaboration.patch.proposed',
  PATCH_ACCEPTED: 'collaboration.patch.accepted',
  PATCH_REJECTED: 'collaboration.patch.rejected',
  PATCH_SUPERSEDED: 'collaboration.patch.superseded',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const ShareScope = {
  SUMMARY: 'SUMMARY',
  FULL: 'FULL',
} as const;
export type ShareScope = (typeof ShareScope)[keyof typeof ShareScope];
