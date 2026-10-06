/**
 * Response shapes, mirrored from `@codelens/shared`.
 *
 * Deliberately re-declared rather than imported. `@codelens/shared` pulls in Zod and is compiled
 * for Node, and the browser bundle does not need a validation library to render a response it did
 * not produce. The tradeoff is real — these can drift from the API — so they are kept narrow:
 * only the fields the UI actually reads, which is also the set a drift would break visibly.
 */

export type Role = 'DEVELOPER' | 'REVIEWER' | 'ADMIN' | 'OWNER';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'NEEDS_DISCUSSION';
export type ApprovalRecommendation = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT_ONLY';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext?: boolean;
  hasPrevious?: boolean;
}

// ---------------------------------------------------------------- auth

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  githubLogin: string | null;
  githubConnected: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface SessionResponse {
  user: PublicUser;
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
}

export interface AuthResponse extends SessionResponse {
  tokens: { accessToken: string; expiresIn: number };
}

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  plan: string;
  memberCount: number;
  repositoryCount: number;
  myRole: Role;
}

// ---------------------------------------------------------------- health

export interface HealthCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  required: boolean;
  detail?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptimeSeconds: number;
  checks: HealthCheck[];
}

// ---------------------------------------------------------------- repositories

export interface RepositoryView {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  primaryLanguage: string | null;
  indexStatus: 'NOT_INDEXED' | 'QUEUED' | 'INDEXING' | 'INDEXED' | 'FAILED' | 'STALE';
  indexedAt: string | null;
  indexedChunkCount: number;
  indexError: string | null;
  openPullRequestCount: number;
  lastSyncedAt: string | null;
  connectedAt: string;
}

// ---------------------------------------------------------------- pull requests

export interface PullRequestListItem {
  id: string;
  repository: { id: string; fullName: string };
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT';
  author: { login: string; avatarUrl: string | null; userId: string | null };
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  draft: boolean;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  risk: { score: number; level: RiskLevel; modelVersion: string } | null;
  latestRun: { id: string; status: string; stage: string; finishedAt: string | null } | null;
  humanReviewSummary: { approvals: number; changesRequested: number; needsDiscussion: number };
  unresolvedCommentCount: number;
  flags: string[];
}

// ---------------------------------------------------------------- jobs

export interface JobStatus {
  id: string;
  queue: string;
  name: string;
  state: 'QUEUED' | 'DELAYED' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  progress: { percent: number; stage: string; message?: string; reviewRunId?: string } | null;
  attemptsMade: number;
  maxAttempts: number;
  deduplicated: boolean;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: { reviewRunId?: string; status?: string; degradation?: string[] } | null;
  failedReason: string | null;
  reviewRunId: string | null;
}

// ---------------------------------------------------------------- analysis

export interface RiskReason {
  label: string;
  value: number;
  feature: string;
  direction: 'INCREASES_RISK' | 'DECREASES_RISK';
  explanation: string;
  contribution: number;
}

export interface RiskView {
  score: number;
  level: RiskLevel;
  probability: number;
  confidence: number;
  isBaseline: boolean;
  reasons: RiskReason[];
  predictedReviewTimeMinutes: number | null;
  reviewTimeRange: { lower: number; upper: number } | null;
  similarPullRequests: Array<{
    reference: string;
    title: string;
    similarity: number;
    outcome: string;
    riskScore: number;
  }>;
  modelName: string;
  modelVersion: string;
  status: string;
  degradedReason: string | null;
}

export interface FindingView {
  id: string;
  analyzer: string;
  ruleId: string;
  severity: Severity;
  category: string;
  message: string;
  path: string | null;
  line: number | null;
  helpUrl: string | null;
  snippet: string | null;
  fingerprint: string;
  preexisting: boolean;
  sourceToolRunId: string | null;
}

export interface AiReviewView {
  id: string;
  executiveSummary: string;
  technicalSummary: string;
  beginnerExplanation: string;
  recommendationRationale: string;
  modelRecommendation: ApprovalRecommendation;
  effectiveRecommendation: ApprovalRecommendation;
  policyOverridden: boolean;
  policyReasons: string[];
  confidence: number;
  fileExplanations: Array<{
    path: string;
    whatChanged: string;
    whyItMatters: string;
    concerns: string[];
    relatedContextPaths: string[];
  }>;
  findings: Array<{
    category: string;
    severity: Severity;
    title: string;
    explanation: string;
    path: string | null;
    line: number | null;
    suggestedFix: string | null;
    evidence: string[];
    confidence: number;
  }>;
  missingTests: string[];
  suggestedTestCases: Array<{
    description: string;
    path: string;
    code: string;
    rationale: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
  reviewerChecklist: Array<{
    item: string;
    rationale: string;
    fromPolicy: boolean;
    status: 'LIKELY_SATISFIED' | 'NEEDS_ATTENTION' | 'CANNOT_DETERMINE';
  }>;
  openQuestions: string[];
  droppedFindingCount: number;
  usedMapReduce: boolean;
  provider: string;
  model: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  costCents: number;
  createdAt: string;
}

/** Why there is no AI review, in the form the UI branches on. */
export interface AiReviewStatus {
  state: 'GENERATED' | 'SKIPPED' | 'FAILED' | 'NOT_RUN';
  reason: string | null;
  retryable: boolean;
}

export interface RunView {
  id: string;
  status: string;
  stage: string;
  progress: number;
  trigger: string;
  triggeredBy: { id: string; name: string } | null;
  headSha: string;
  stale: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokenUsage: { prompt: number; completion: number; total: number };
  costCents: number;
  capabilities: {
    staticAnalysis: boolean;
    mlRisk: boolean;
    ragContext: boolean;
    aiReview: boolean;
  };
}

export interface ToolRunSummary {
  id: string;
  tool: string;
  status: string;
  sequence: number;
  durationMs: number;
  cacheHit: boolean;
  error: string | null;
  costCents: number;
  tokenUsage: { prompt: number; completion: number; total: number } | null;
}

export interface MetricsView {
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  commitCount: number;
  complexityBefore: number;
  complexityAfter: number;
  complexityDelta: number;
  securityFindingsCount: number;
  testFilesChanged: number;
  dependencyChanged: boolean;
  authFileChanged: boolean;
  databaseFileChanged: boolean;
  paymentFileChanged: boolean;
  infraFileChanged: boolean;
  previousRiskyFileCount: number;
}

// ---------------------------------------------------------------- review session

export interface ReviewView {
  id: string;
  reviewer: { id: string; name: string; avatarUrl: string | null };
  verdict: ReviewVerdict;
  summary: string | null;
  headSha: string;
  stale: boolean;
  dismissedFindingCount: number;
  createdAt: string;
}

export interface ReviewGateStatus {
  readyToMerge: boolean;
  requiredApprovals: number;
  currentApprovals: number;
  blockingReasons: string[];
  warnings: string[];
  changesRequestedBy: Array<{ id: string; name: string }>;
}

export interface CommentView {
  id: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  origin: 'HUMAN' | 'AI';
  body: string;
  path: string | null;
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  parentId: string | null;
  replies: CommentView[];
  findingFingerprint: string | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  editedAt: string | null;
  createdAt: string;
  outdated: boolean;
}

export interface ShareLinkView {
  id: string;
  url: string;
  scope: 'SUMMARY' | 'FULL';
  redactCode: boolean;
  hasPassphrase: boolean;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
}

export interface ReviewPermissions {
  canComment: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canModerateComments: boolean;
  canCreateShareLink: boolean;
  canRevokeShareLink: boolean;
  canTriggerAnalysis: boolean;
  canPostToGithub: boolean;
  deniedReasons: Record<string, string>;
}

export interface RagContextSummary {
  chunkCount: number;
  totalTokens: number;
  repositoryOverviewCount: number;
  chunks: Array<{
    forFilePath: string | null;
    path: string;
    symbol: string | null;
    kind: string;
    tokenCount: number;
    score: number;
    sources: string[];
    rationale: string | null;
  }>;
}

export interface ReviewSession {
  sessionId: string;
  pullRequestId: string;
  repository: {
    id: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
    primaryLanguage: string | null;
    indexStatus: string;
  };
  pullRequest: {
    id: string;
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft: boolean;
    htmlUrl: string;
    author: { login: string; avatarUrl: string | null; userId: string | null };
    headRef: string;
    headSha: string;
    baseRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    commitCount: number;
    merged: boolean;
    labels: string[];
    githubCreatedAt: string | null;
    firstReviewedAt: string | null;
  };
  analyzed: boolean;
  run: RunView | null;
  risk: RiskView | null;
  findings: FindingView[];
  aiReview: AiReviewView | null;
  aiReviewStatus: AiReviewStatus;
  summary: string | null;
  metrics: MetricsView | null;
  ragContext: RagContextSummary;
  toolRuns: ToolRunSummary[];
  reviews: ReviewView[];
  gate: ReviewGateStatus;
  comments: CommentView[];
  shareLinks: ShareLinkView[];
  permissions: ReviewPermissions;
  degradation: string[];
}

export interface OpenSessionResponse {
  session: ReviewSession;
  job: JobStatus | null;
  pollUrl?: string;
}

// ---------------------------------------------------------------- shared view

export interface SharedReview {
  shared: true;
  scope: 'SUMMARY' | 'FULL';
  redactCode: boolean;
  expiresAt: string;
  repository: { fullName: string };
  pullRequest: {
    number: number;
    title: string;
    state: string;
    htmlUrl: string;
    authorLogin: string;
    headSha: string;
    baseRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    commitCount: number;
    createdAt: string | null;
  };
  analyzed: boolean;
  run: {
    status: string;
    stale: boolean;
    finishedAt: string | null;
    capabilities: RunView['capabilities'];
  } | null;
  risk: Pick<
    RiskView,
    'score' | 'level' | 'confidence' | 'reasons' | 'predictedReviewTimeMinutes' | 'isBaseline' | 'modelName'
  > | null;
  summary: string | null;
  findingSummary: {
    total: number;
    new: number;
    bySeverity: Record<string, number>;
    blockingSeverity: Severity;
  };
  findings: Array<{
    analyzer: string;
    ruleId: string;
    severity: Severity;
    category: string;
    message: string;
    path: string | null;
    line: number | null;
    helpUrl: string | null;
    preexisting: boolean;
    snippet: string | null;
  }>;
  aiReview: Partial<
    Pick<
      AiReviewView,
      | 'executiveSummary'
      | 'technicalSummary'
      | 'beginnerExplanation'
      | 'recommendationRationale'
      | 'effectiveRecommendation'
      | 'confidence'
      | 'fileExplanations'
      | 'missingTests'
      | 'openQuestions'
      | 'reviewerChecklist'
    >
  > | null;
  metrics: MetricsView | null;
  ragContext: { chunkCount: number; files: string[] } | null;
  verdicts: {
    approvals: number;
    changesRequested: number;
    needsDiscussion: number;
    reviewers: Array<{ name: string; verdict: ReviewVerdict; at: string }>;
  };
  degradation: string[];
}

// ---------------------------------------------------------------- audit

export interface AuditLogView {
  id: string;
  action: string;
  actor: { id: string; name: string; email: string } | null;
  actorType: 'USER' | 'SYSTEM' | 'WEBHOOK' | 'API_KEY';
  resourceType: string;
  resourceId: string | null;
  description: string;
  createdAt: string;
}
