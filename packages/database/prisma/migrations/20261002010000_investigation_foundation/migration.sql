CREATE UNIQUE INDEX "Repository_id_organizationId_key" ON "Repository"("id", "organizationId");
CREATE UNIQUE INDEX "CollaborationTurn_id_organizationId_pullRequestId_key" ON "CollaborationTurn"("id", "organizationId", "pullRequestId");
CREATE TABLE "CollaborationToolCall" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "tool" VARCHAR(64) NOT NULL,
  "version" VARCHAR(16) NOT NULL DEFAULT '1',
  "sequence" INTEGER NOT NULL CHECK ("sequence" BETWEEN 1 AND 8),
  "requestId" VARCHAR(64) NOT NULL,
  "inputHash" VARCHAR(64) NOT NULL,
  "fence" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RUNNING' CHECK ("status" IN ('RUNNING','SUCCESS','PARTIAL','UNAVAILABLE','TIMEOUT','CANCELLED','LIMITED')),
  "coverage" VARCHAR(500) NOT NULL DEFAULT 'Pending investigation',
  "nextCursor" INTEGER,
  "failureCategory" VARCHAR(32),
  "diagnostic" VARCHAR(300),
  "traceId" VARCHAR(128) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER NOT NULL DEFAULT 0 CHECK ("durationMs" >= 0),
  FOREIGN KEY ("turnId", "organizationId", "pullRequestId") REFERENCES "CollaborationTurn"("id", "organizationId", "pullRequestId") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("pullRequestId", "organizationId") REFERENCES "PullRequest"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("repositoryId", "organizationId") REFERENCES "Repository"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CollaborationToolCall_id_turnId_organizationId_key" ON "CollaborationToolCall"("id", "turnId", "organizationId");
CREATE UNIQUE INDEX "CollaborationToolCall_turnId_sequence_key" ON "CollaborationToolCall"("turnId", "sequence");
CREATE UNIQUE INDEX "CollaborationToolCall_turnId_requestedById_requestId_key" ON "CollaborationToolCall"("turnId", "requestedById", "requestId");
CREATE INDEX "CollaborationToolCall_organizationId_turnId_sequence_idx" ON "CollaborationToolCall"("organizationId", "turnId", "sequence");
CREATE INDEX "CollaborationToolCall_status_deadlineAt_idx" ON "CollaborationToolCall"("status", "deadlineAt");
CREATE TABLE "EvidenceReference" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" > 0),
  "sourceType" VARCHAR(40) NOT NULL,
  "sourceId" VARCHAR(160),
  "provenance" VARCHAR(24) NOT NULL CHECK ("provenance" IN ('EXACT_REVISION','INDEXED_CONTEXT','SNAPSHOT','DERIVED')),
  "observedRevision" VARCHAR(64), "indexRevision" VARCHAR(64),
  "path" VARCHAR(500), "side" VARCHAR(8), "startLine" INTEGER, "endLine" INTEGER,
  "contentHash" VARCHAR(64) NOT NULL, "blobHash" VARCHAR(40), "payloadHash" VARCHAR(64) NOT NULL,
  "excerpt" TEXT NOT NULL CHECK (octet_length("excerpt") <= 16384),
  "truncated" BOOLEAN NOT NULL DEFAULT false, "redacted" BOOLEAN NOT NULL DEFAULT false,
  "method" VARCHAR(80) NOT NULL, "metadata" JSONB NOT NULL DEFAULT '{}',
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("toolCallId", "turnId", "organizationId") REFERENCES "CollaborationToolCall"("id", "turnId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EvidenceReference_toolCallId_ordinal_key" ON "EvidenceReference"("toolCallId", "ordinal");
CREATE INDEX "EvidenceReference_organizationId_turnId_idx" ON "EvidenceReference"("organizationId", "turnId");
