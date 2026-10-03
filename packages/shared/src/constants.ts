import { FindingCategory, RiskLevel, Role, Severity } from './enums';

// ---------------------------------------------------------------- api

export const API_PREFIX = 'api';
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/${API_PREFIX}/${API_VERSION}`;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------- auth

export const ACCESS_TOKEN_COOKIE = 'codelens_access';
export const REFRESH_TOKEN_COOKIE = 'codelens_refresh';
export const OAUTH_STATE_COOKIE = 'codelens_oauth_state';

/** OAuth `state` lifetime. Short on purpose: it only has to survive a redirect. */
export const OAUTH_STATE_TTL_SECONDS = 600;

export const MIN_PASSWORD_LENGTH = 12;
export const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------- risk scoring

/**
 * Risk score band boundaries (inclusive lower bound).
 *
 * The ML service returns a continuous 0–100 score; banding happens here so the
 * web app, the API and any future CLI all draw the same lines.
 */
export const RISK_THRESHOLDS: Record<Exclude<RiskLevel, 'LOW'>, number> = {
  MEDIUM: 35,
  HIGH: 60,
  CRITICAL: 85,
};

export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.CRITICAL) return RiskLevel.CRITICAL;
  if (score >= RISK_THRESHOLDS.HIGH) return RiskLevel.HIGH;
  if (score >= RISK_THRESHOLDS.MEDIUM) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

export const RISK_LEVEL_COLORS: Record<RiskLevel, string> = {
  LOW: 'emerald',
  MEDIUM: 'amber',
  HIGH: 'orange',
  CRITICAL: 'red',
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  CRITICAL: 'red',
  HIGH: 'orange',
  MEDIUM: 'amber',
  LOW: 'sky',
  INFO: 'slate',
};

export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  BUG: 'Bug risk',
  SECURITY: 'Security',
  PERFORMANCE: 'Performance',
  MAINTAINABILITY: 'Maintainability',
  TESTING: 'Testing',
  STYLE: 'Style',
  DEPENDENCY: 'Dependency',
  TYPE_SAFETY: 'Type safety',
};

// ---------------------------------------------------------------- policy defaults

/**
 * Default review policy for a new organization. Deliberately permissive: a tool
 * that blocks merges on day one gets uninstalled on day two. Admins tighten
 * these once the team trusts the signal.
 */
export const DEFAULT_REVIEW_POLICY = {
  /** Findings at or above this severity are highlighted as blocking. */
  blockingSeverity: Severity.HIGH,
  /** Risk score at or above this surfaces a "needs senior review" banner. */
  riskScoreGate: 70,
  /** Require at least one test file change when non-trivial code changed. */
  requireTestsForCodeChanges: true,
  /** Minimum distinct human approvals before the UI shows "ready to merge". */
  minApprovals: 1,
  /** Extra approvals required when a PR touches these flags. */
  sensitiveFlagsRequireTwoApprovals: true,
  /** Never post to GitHub without an explicit opt-in. */
  autoPostGithubComment: false,
  /** Block the review if a secret is detected in the diff. */
  blockOnSecretDetection: true,
  /** Minimum role that may post an AI review back to GitHub. */
  githubCommentMinRole: Role.REVIEWER,
  checklist: [
    'Change matches the stated intent of the PR description',
    'Error paths and edge cases are handled',
    'No secrets, tokens or credentials in the diff',
    'Tests cover the new behaviour',
    'Public API or schema changes are backward compatible',
    'Logging and metrics are sufficient to debug this in production',
  ],
} as const;

// ---------------------------------------------------------------- limits

/** Diffs larger than this switch the agent to map-reduce review. */
export const LARGE_PR_FILE_THRESHOLD = 25;
export const LARGE_PR_LINE_THRESHOLD = 1500;

/** Hard cap on patch text held in memory per file (characters). */
export const MAX_PATCH_CHARS_PER_FILE = 60_000;

/** GitHub caps `files` at 3000 per PR; we stop well short for sanity. */
export const MAX_FILES_PER_REVIEW = 300;

export const MAX_COMMITS_FETCHED = 250;

// ---------------------------------------------------------------- rag

export const DEFAULT_RAG_TOP_K = 12;
export const DEFAULT_RAG_MMR_LAMBDA = 0.7;
export const DEFAULT_CHUNK_MAX_TOKENS = 800;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 80;

/**
 * Rough chars-per-token ratio for code. Real tokenizers vary by model; this is
 * only used for budgeting, where a conservative estimate is the right call.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 3.6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

// ---------------------------------------------------------------- queues

export const QUEUE_NAMES = {
  COLLABORATION: 'collaboration',
  REVIEW_RUN: 'review-run',
  REPO_INDEX: 'repo-index',
  PR_SYNC: 'pr-sync',
  GITHUB_PUBLISH: 'github-publish',
  MODEL_RETRAIN: 'model-retrain',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  ANALYZE_PULL_REQUEST: 'analyze-pull-request',
  INDEX_REPOSITORY: 'index-repository',
  SYNC_PULL_REQUESTS: 'sync-pull-requests',
  POST_REVIEW_COMMENT: 'post-review-comment',
  RETRAIN_ORG_MODEL: 'retrain-org-model',
} as const;

// ---------------------------------------------------------------- caching

export const CACHE_KEYS = {
  prDiff: (repoFullName: string, headSha: string) => `diff:${repoFullName}:${headSha}`,
  repoMeta: (repoFullName: string) => `repo:${repoFullName}`,
  embedding: (contentHash: string) => `emb:${contentHash}`,
  githubRateLimit: (userId: string) => `ghrl:${userId}`,
} as const;

export const CACHE_TTL_SECONDS = {
  PR_DIFF: 3600,
  REPO_META: 900,
  EMBEDDING: 60 * 60 * 24 * 30,
} as const;

// ---------------------------------------------------------------- prompts

/**
 * Bumped whenever a review prompt template changes. Stored on `AiReview` so a
 * shift in output quality can be attributed to a specific prompt revision.
 */
export const PROMPT_VERSION = 'review-2026.09.1';
