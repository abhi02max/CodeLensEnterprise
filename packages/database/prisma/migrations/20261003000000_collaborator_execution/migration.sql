ALTER TYPE "CollaborationTurnStatus" ADD VALUE 'QUEUED';
ALTER TYPE "CollaborationTurnStatus" ADD VALUE 'RUNNING';
ALTER TYPE "CollaborationTurnStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "CollaborationTurnStatus" ADD VALUE 'FAILED';
ALTER TYPE "CollaborationTurnStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "CollaborationTurnStatus" ADD VALUE 'INTERRUPTED';
ALTER TYPE "ConversationMessageKind" ADD VALUE 'ASSISTANT';
ALTER TABLE "CollaborationTurn" ADD COLUMN "executionAttempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ConversationMessage"
  ADD COLUMN "citations" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "provider" VARCHAR(32),
  ADD COLUMN "model" VARCHAR(128);
CREATE UNIQUE INDEX "ConversationMessage_turnId_kind_key" ON "ConversationMessage"("turnId", "kind");
CREATE TABLE "CollaborationAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL,
  "number" INTEGER NOT NULL CHECK ("number" > 0),
  "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  "fence" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(32) NOT NULL DEFAULT 'collaborator-v1',
  "traceId" VARCHAR(128) NOT NULL,
  "provider" VARCHAR(32),
  "model" VARCHAR(128),
  "failureCategory" VARCHAR(32),
  "providerRequests" INTEGER NOT NULL DEFAULT 0 CHECK ("providerRequests" BETWEEN 0 AND 5),
  "providerRetries" INTEGER NOT NULL DEFAULT 0 CHECK ("providerRetries" BETWEEN 0 AND 4),
  "repairs" INTEGER NOT NULL DEFAULT 0 CHECK ("repairs" BETWEEN 0 AND 1),
  "rounds" INTEGER NOT NULL DEFAULT 0 CHECK ("rounds" BETWEEN 0 AND 4),
  "toolCalls" INTEGER NOT NULL DEFAULT 0 CHECK ("toolCalls" BETWEEN 0 AND 8),
  "contextBytes" INTEGER NOT NULL DEFAULT 0 CHECK ("contextBytes" BETWEEN 0 AND 12000),
  "outputTokens" INTEGER NOT NULL DEFAULT 0 CHECK ("outputTokens" BETWEEN 0 AND 8000),
  "providerDurationMs" INTEGER NOT NULL DEFAULT 0,
  "toolDurationMs" INTEGER NOT NULL DEFAULT 0,
  "availableEvidenceIds" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  FOREIGN KEY ("turnId", "organizationId", "pullRequestId") REFERENCES "CollaborationTurn"("id", "organizationId", "pullRequestId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CollaborationAttempt_turnId_number_key" ON "CollaborationAttempt"("turnId", "number");
CREATE INDEX "CollaborationAttempt_organizationId_turnId_idx" ON "CollaborationAttempt"("organizationId", "turnId");
CREATE INDEX "CollaborationAttempt_status_deadlineAt_idx" ON "CollaborationAttempt"("status", "deadlineAt");
