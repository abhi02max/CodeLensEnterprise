-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('DEVELOPER', 'REVIEWER', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('OPENAI', 'ANTHROPIC', 'OPENROUTER');

-- CreateEnum
CREATE TYPE "IndexStatus" AS ENUM ('NOT_INDEXED', 'QUEUED', 'INDEXING', 'INDEXED', 'FAILED', 'STALE');

-- CreateEnum
CREATE TYPE "PullRequestState" AS ENUM ('OPEN', 'CLOSED', 'MERGED', 'DRAFT');

-- CreateEnum
CREATE TYPE "FileChangeStatus" AS ENUM ('ADDED', 'MODIFIED', 'REMOVED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED');

-- CreateEnum
CREATE TYPE "ReviewRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ReviewStage" AS ENUM ('PENDING', 'FETCHING_DIFF', 'STATIC_ANALYSIS', 'FEATURE_EXTRACTION', 'RISK_PREDICTION', 'CONTEXT_RETRIEVAL', 'AI_REVIEW', 'TEST_SUGGESTIONS', 'REPORT_ASSEMBLY', 'PUBLISHING', 'DONE');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('USER', 'WEBHOOK', 'SCHEDULE', 'API');

-- CreateEnum
CREATE TYPE "ToolRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "AnalyzerKind" AS ENUM ('ESLINT', 'SEMGREP', 'NPM_AUDIT', 'TSC', 'METRICS', 'SECRET_SCAN', 'PATTERN_SCAN');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('BUG', 'SECURITY', 'PERFORMANCE', 'MAINTAINABILITY', 'TESTING', 'STYLE', 'DEPENDENCY', 'TYPE_SAFETY');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MlStatus" AS ENUM ('OK', 'UNAVAILABLE', 'DEGRADED');

-- CreateEnum
CREATE TYPE "ApprovalRecommendation" AS ENUM ('APPROVE', 'REQUEST_CHANGES', 'NEEDS_DISCUSSION');

-- CreateEnum
CREATE TYPE "ChunkKind" AS ENUM ('FILE', 'FUNCTION', 'CLASS', 'METHOD', 'INTERFACE', 'ROUTE', 'SCHEMA_MODEL', 'TEST_CASE', 'DOC_SECTION', 'CONFIG_BLOCK');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'NEEDS_DISCUSSION');

-- CreateEnum
CREATE TYPE "CommentOrigin" AS ENUM ('HUMAN', 'AI');

-- CreateEnum
CREATE TYPE "ShareScope" AS ENUM ('SUMMARY', 'FULL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WEBHOOK', 'API_KEY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "tokenGeneration" INTEGER NOT NULL DEFAULT 0,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "providerLogin" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'DEVELOPER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'DEVELOPER',
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "teamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "blockingSeverity" "Severity" NOT NULL DEFAULT 'HIGH',
    "riskScoreGate" INTEGER NOT NULL DEFAULT 70,
    "requireTestsForCodeChanges" BOOLEAN NOT NULL DEFAULT true,
    "minApprovals" INTEGER NOT NULL DEFAULT 1,
    "sensitiveFlagsRequireTwoApprovals" BOOLEAN NOT NULL DEFAULT true,
    "autoPostGithubComment" BOOLEAN NOT NULL DEFAULT false,
    "blockOnSecretDetection" BOOLEAN NOT NULL DEFAULT true,
    "githubCommentMinRole" "Role" NOT NULL DEFAULT 'REVIEWER',
    "checklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extraSemgrepRulesets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "AiProviderKind" NOT NULL DEFAULT 'OPENAI',
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 8000,
    "maxCostCentsPerRun" INTEGER NOT NULL DEFAULT 50,
    "allowExternalModelCalls" BOOLEAN NOT NULL DEFAULT true,
    "redactSecretsBeforeSend" BOOLEAN NOT NULL DEFAULT true,
    "embeddingProvider" TEXT NOT NULL DEFAULT 'openai',
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "description" TEXT,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "primaryLanguage" TEXT,
    "htmlUrl" TEXT,
    "indexStatus" "IndexStatus" NOT NULL DEFAULT 'NOT_INDEXED',
    "indexedAt" TIMESTAMP(3),
    "indexError" TEXT,
    "indexedChunkCount" INTEGER NOT NULL DEFAULT 0,
    "indexedCommitSha" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryTeam" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,

    CONSTRAINT "RepositoryTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" "PullRequestState" NOT NULL DEFAULT 'OPEN',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "htmlUrl" TEXT NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "authorAvatarUrl" TEXT,
    "authorUserId" TEXT,
    "headRef" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "commitCount" INTEGER NOT NULL DEFAULT 0,
    "mergeable" BOOLEAN,
    "merged" BOOLEAN NOT NULL DEFAULT false,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "githubCreatedAt" TIMESTAMP(3) NOT NULL,
    "githubUpdatedAt" TIMESTAMP(3) NOT NULL,
    "latestRiskScore" INTEGER,
    "latestRiskLevel" "RiskLevel",
    "firstReviewedAt" TIMESTAMP(3),
    "actualReviewMinutes" INTEGER,
    "wasRisky" BOOLEAN,
    "riskLabelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestFile" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "previousFilename" TEXT,
    "status" "FileChangeStatus" NOT NULL,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changes" INTEGER NOT NULL DEFAULT 0,
    "language" TEXT NOT NULL DEFAULT 'unknown',
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "patch" TEXT,
    "patchTruncated" BOOLEAN NOT NULL DEFAULT false,
    "binary" BOOLEAN NOT NULL DEFAULT false,
    "touchedLines" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PullRequestFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commit" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorEmail" TEXT,
    "authorLogin" TEXT,
    "authoredAt" TIMESTAMP(3) NOT NULL,
    "additions" INTEGER,
    "deletions" INTEGER,

    CONSTRAINT "Commit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "status" "ReviewRunStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "ReviewStage" NOT NULL DEFAULT 'PENDING',
    "trigger" "RunTrigger" NOT NULL DEFAULT 'USER',
    "triggeredByUserId" TEXT,
    "headSha" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "hadStaticAnalysis" BOOLEAN NOT NULL DEFAULT false,
    "hadMlRisk" BOOLEAN NOT NULL DEFAULT false,
    "hadRagContext" BOOLEAN NOT NULL DEFAULT false,
    "hadAiReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolRun" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" "ToolRunStatus" NOT NULL DEFAULT 'SUCCESS',
    "sequence" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ToolRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaticFinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "sourceToolRunId" TEXT NOT NULL,
    "analyzer" "AnalyzerKind" NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "endLine" INTEGER,
    "column" INTEGER,
    "helpUrl" TEXT,
    "snippet" TEXT,
    "fingerprint" TEXT NOT NULL,
    "preexisting" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaticFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DismissedFinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "pullRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DismissedFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrMetrics" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "linesAdded" INTEGER NOT NULL DEFAULT 0,
    "linesDeleted" INTEGER NOT NULL DEFAULT 0,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "commitCount" INTEGER NOT NULL DEFAULT 0,
    "functionsChanged" INTEGER NOT NULL DEFAULT 0,
    "complexityBefore" INTEGER NOT NULL DEFAULT 0,
    "complexityAfter" INTEGER NOT NULL DEFAULT 0,
    "complexityDelta" INTEGER NOT NULL DEFAULT 0,
    "maxFunctionComplexity" INTEGER NOT NULL DEFAULT 0,
    "securityFindingsCount" INTEGER NOT NULL DEFAULT 0,
    "testFilesChanged" INTEGER NOT NULL DEFAULT 0,
    "testToCodeRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dependencyChanged" BOOLEAN NOT NULL DEFAULT false,
    "authFileChanged" BOOLEAN NOT NULL DEFAULT false,
    "databaseFileChanged" BOOLEAN NOT NULL DEFAULT false,
    "configFileChanged" BOOLEAN NOT NULL DEFAULT false,
    "paymentFileChanged" BOOLEAN NOT NULL DEFAULT false,
    "infraFileChanged" BOOLEAN NOT NULL DEFAULT false,
    "previousRiskyFileCount" INTEGER NOT NULL DEFAULT 0,
    "titleText" TEXT NOT NULL,
    "commitText" TEXT NOT NULL,
    "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlPrediction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "status" "MlStatus" NOT NULL DEFAULT 'OK',
    "degradedReason" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "probability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isBaseline" BOOLEAN NOT NULL DEFAULT true,
    "predictedReviewTimeMinutes" DOUBLE PRECISION,
    "reviewTimeLowerMinutes" DOUBLE PRECISION,
    "reviewTimeUpperMinutes" DOUBLE PRECISION,
    "topRiskReasons" JSONB NOT NULL DEFAULT '[]',
    "similarPullRequests" JSONB NOT NULL DEFAULT '[]',
    "issueClusters" JSONB NOT NULL DEFAULT '[]',
    "modelName" TEXT NOT NULL DEFAULT 'baseline',
    "modelVersion" TEXT NOT NULL DEFAULT 'bootstrap-v1',
    "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "executiveSummary" TEXT NOT NULL,
    "technicalSummary" TEXT NOT NULL,
    "beginnerExplanation" TEXT NOT NULL,
    "recommendationRationale" TEXT NOT NULL,
    "modelRecommendation" "ApprovalRecommendation" NOT NULL,
    "effectiveRecommendation" "ApprovalRecommendation" NOT NULL,
    "policyOverridden" BOOLEAN NOT NULL DEFAULT false,
    "policyReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fileExplanations" JSONB NOT NULL DEFAULT '[]',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "missingTests" JSONB NOT NULL DEFAULT '[]',
    "suggestedTestCases" JSONB NOT NULL DEFAULT '[]',
    "reviewerChecklist" JSONB NOT NULL DEFAULT '[]',
    "openQuestions" JSONB NOT NULL DEFAULT '[]',
    "droppedFindingCount" INTEGER NOT NULL DEFAULT 0,
    "usedMapReduce" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagChunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "symbol" TEXT,
    "kind" "ChunkKind" NOT NULL DEFAULT 'FILE',
    "language" TEXT NOT NULL DEFAULT 'unknown',
    "content" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL DEFAULT 1,
    "endLine" INTEGER NOT NULL DEFAULT 1,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1536),
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RagChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetrievedContext" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "forFilePath" TEXT,
    "chunkId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "symbol" TEXT,
    "kind" "ChunkKind" NOT NULL,
    "content" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "vectorScore" DOUBLE PRECISION,
    "lexicalScore" DOUBLE PRECISION,
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rationale" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetrievedContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "status" "IndexStatus" NOT NULL DEFAULT 'QUEUED',
    "filesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "filesProcessed" INTEGER NOT NULL DEFAULT 0,
    "filesSkipped" INTEGER NOT NULL DEFAULT 0,
    "chunksCreated" INTEGER NOT NULL DEFAULT 0,
    "chunksReused" INTEGER NOT NULL DEFAULT 0,
    "embeddingsGenerated" INTEGER NOT NULL DEFAULT 0,
    "tokensEmbedded" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "commitSha" TEXT,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "IndexRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "verdict" "ReviewVerdict" NOT NULL,
    "summary" TEXT,
    "headSha" TEXT NOT NULL,
    "acknowledgedChecklistItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dismissedFindingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "authorId" TEXT,
    "origin" "CommentOrigin" NOT NULL DEFAULT 'HUMAN',
    "body" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "side" TEXT NOT NULL DEFAULT 'RIGHT',
    "parentId" TEXT,
    "findingFingerprint" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "outdated" BOOLEAN NOT NULL DEFAULT false,
    "githubCommentId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" "ShareScope" NOT NULL DEFAULT 'SUMMARY',
    "redactCode" BOOLEAN NOT NULL DEFAULT false,
    "passphraseHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "actorId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_lastActiveAt_idx" ON "User"("lastActiveAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Membership_organizationId_role_idx" ON "Membership"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "Team_organizationId_idx" ON "Team"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_name_key" ON "Team"("organizationId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_organizationId_email_idx" ON "Invite"("organizationId", "email");

-- CreateIndex
CREATE INDEX "Invite_expiresAt_idx" ON "Invite"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPolicy_organizationId_key" ON "ReviewPolicy"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AiSettings_organizationId_key" ON "AiSettings"("organizationId");

-- CreateIndex
CREATE INDEX "Repository_organizationId_fullName_idx" ON "Repository"("organizationId", "fullName");

-- CreateIndex
CREATE INDEX "Repository_indexStatus_idx" ON "Repository"("indexStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_organizationId_githubId_key" ON "Repository"("organizationId", "githubId");

-- CreateIndex
CREATE INDEX "RepositoryTeam_teamId_idx" ON "RepositoryTeam"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryTeam_repositoryId_teamId_key" ON "RepositoryTeam"("repositoryId", "teamId");

-- CreateIndex
CREATE INDEX "PullRequest_organizationId_state_githubUpdatedAt_idx" ON "PullRequest"("organizationId", "state", "githubUpdatedAt" DESC);

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_state_githubUpdatedAt_idx" ON "PullRequest"("repositoryId", "state", "githubUpdatedAt" DESC);

-- CreateIndex
CREATE INDEX "PullRequest_organizationId_latestRiskLevel_idx" ON "PullRequest"("organizationId", "latestRiskLevel");

-- CreateIndex
CREATE INDEX "PullRequest_authorLogin_idx" ON "PullRequest"("authorLogin");

-- CreateIndex
CREATE INDEX "PullRequest_wasRisky_idx" ON "PullRequest"("wasRisky");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repositoryId_number_key" ON "PullRequest"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "PullRequestFile_pullRequestId_idx" ON "PullRequestFile"("pullRequestId");

-- CreateIndex
CREATE INDEX "PullRequestFile_filename_idx" ON "PullRequestFile"("filename");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestFile_pullRequestId_filename_key" ON "PullRequestFile"("pullRequestId", "filename");

-- CreateIndex
CREATE INDEX "Commit_pullRequestId_idx" ON "Commit"("pullRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Commit_pullRequestId_sha_key" ON "Commit"("pullRequestId", "sha");

-- CreateIndex
CREATE INDEX "ReviewRun_organizationId_createdAt_idx" ON "ReviewRun"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ReviewRun_pullRequestId_createdAt_idx" ON "ReviewRun"("pullRequestId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ReviewRun_status_stage_idx" ON "ReviewRun"("status", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRun_idempotencyKey_key" ON "ReviewRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ToolRun_reviewRunId_idx" ON "ToolRun"("reviewRunId");

-- CreateIndex
CREATE INDEX "ToolRun_tool_status_idx" ON "ToolRun"("tool", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ToolRun_reviewRunId_sequence_key" ON "ToolRun"("reviewRunId", "sequence");

-- CreateIndex
CREATE INDEX "StaticFinding_organizationId_severity_createdAt_idx" ON "StaticFinding"("organizationId", "severity", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "StaticFinding_reviewRunId_preexisting_idx" ON "StaticFinding"("reviewRunId", "preexisting");

-- CreateIndex
CREATE INDEX "StaticFinding_ruleId_idx" ON "StaticFinding"("ruleId");

-- CreateIndex
CREATE INDEX "StaticFinding_path_idx" ON "StaticFinding"("path");

-- CreateIndex
CREATE UNIQUE INDEX "StaticFinding_reviewRunId_fingerprint_key" ON "StaticFinding"("reviewRunId", "fingerprint");

-- CreateIndex
CREATE INDEX "DismissedFinding_organizationId_ruleId_idx" ON "DismissedFinding"("organizationId", "ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "DismissedFinding_organizationId_fingerprint_key" ON "DismissedFinding"("organizationId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "PrMetrics_reviewRunId_key" ON "PrMetrics"("reviewRunId");

-- CreateIndex
CREATE UNIQUE INDEX "MlPrediction_reviewRunId_key" ON "MlPrediction"("reviewRunId");

-- CreateIndex
CREATE INDEX "MlPrediction_organizationId_riskLevel_createdAt_idx" ON "MlPrediction"("organizationId", "riskLevel", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AiReview_reviewRunId_key" ON "AiReview"("reviewRunId");

-- CreateIndex
CREATE INDEX "AiReview_organizationId_createdAt_idx" ON "AiReview"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RagChunk_repositoryId_path_idx" ON "RagChunk"("repositoryId", "path");

-- CreateIndex
CREATE INDEX "RagChunk_organizationId_idx" ON "RagChunk"("organizationId");

-- CreateIndex
CREATE INDEX "RagChunk_contentHash_idx" ON "RagChunk"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "RagChunk_repositoryId_path_symbol_contentHash_key" ON "RagChunk"("repositoryId", "path", "symbol", "contentHash");

-- CreateIndex
CREATE INDEX "RetrievedContext_reviewRunId_forFilePath_idx" ON "RetrievedContext"("reviewRunId", "forFilePath");

-- CreateIndex
CREATE INDEX "IndexRun_repositoryId_startedAt_idx" ON "IndexRun"("repositoryId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "IndexRun_organizationId_idx" ON "IndexRun"("organizationId");

-- CreateIndex
CREATE INDEX "Review_organizationId_createdAt_idx" ON "Review"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Review_pullRequestId_idx" ON "Review"("pullRequestId");

-- CreateIndex
CREATE INDEX "Review_reviewerId_idx" ON "Review"("reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_pullRequestId_reviewerId_headSha_key" ON "Review"("pullRequestId", "reviewerId", "headSha");

-- CreateIndex
CREATE INDEX "Comment_pullRequestId_createdAt_idx" ON "Comment"("pullRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_pullRequestId_path_line_idx" ON "Comment"("pullRequestId", "path", "line");

-- CreateIndex
CREATE INDEX "Comment_organizationId_idx" ON "Comment"("organizationId");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_tokenHash_key" ON "ShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ShareLink_pullRequestId_idx" ON "ShareLink"("pullRequestId");

-- CreateIndex
CREATE INDEX "ShareLink_organizationId_idx" ON "ShareLink"("organizationId");

-- CreateIndex
CREATE INDEX "ShareLink_expiresAt_idx" ON "ShareLink"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_action_createdAt_idx" ON "AuditLog"("organizationId", "action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewPolicy" ADD CONSTRAINT "ReviewPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryTeam" ADD CONSTRAINT "RepositoryTeam_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryTeam" ADD CONSTRAINT "RepositoryTeam_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestFile" ADD CONSTRAINT "PullRequestFile_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commit" ADD CONSTRAINT "Commit_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaticFinding" ADD CONSTRAINT "StaticFinding_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaticFinding" ADD CONSTRAINT "StaticFinding_sourceToolRunId_fkey" FOREIGN KEY ("sourceToolRunId") REFERENCES "ToolRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrMetrics" ADD CONSTRAINT "PrMetrics_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlPrediction" ADD CONSTRAINT "MlPrediction_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReview" ADD CONSTRAINT "AiReview_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrievedContext" ADD CONSTRAINT "RetrievedContext_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexRun" ADD CONSTRAINT "IndexRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma cannot model a stored generated tsvector or these specialized indexes.
-- Keep this expression in sync with the RAG compatibility check.
ALTER TABLE "RagChunk"
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("symbol", '')), 'A') ||
  setweight(to_tsvector('english', replace(coalesce("path", ''), '/', ' ')), 'B') ||
  setweight(to_tsvector('english', left(coalesce("content", ''), 20000)), 'C')
) STORED;

CREATE INDEX rag_chunk_search_vector_idx ON "RagChunk" USING gin (search_vector);
CREATE INDEX rag_chunk_path_trgm_idx ON "RagChunk" USING gin ("path" gin_trgm_ops);
CREATE INDEX rag_chunk_embedding_cosine_idx ON "RagChunk" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
