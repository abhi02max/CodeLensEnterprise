CREATE TYPE "ConversationStatus" AS ENUM ('OPEN');
CREATE TYPE "CollaborationTurnStatus" AS ENUM ('RECORDED');
CREATE TYPE "ConversationMessageKind" AS ENUM ('HUMAN');

CREATE UNIQUE INDEX "PullRequest_id_organizationId_key" ON "PullRequest"("id", "organizationId");
CREATE UNIQUE INDEX "ReviewRun_id_organizationId_pullRequestId_key" ON "ReviewRun"("id", "organizationId", "pullRequestId");

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "title" VARCHAR(160) NOT NULL,
  "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "anchor" JSONB,
  "requestId" VARCHAR(64) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "lastSequence" INTEGER NOT NULL DEFAULT 0 CHECK ("lastSequence" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("pullRequestId", "organizationId") REFERENCES "PullRequest"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Conversation_id_organizationId_pullRequestId_key" ON "Conversation"("id", "organizationId", "pullRequestId");
CREATE UNIQUE INDEX "Conversation_id_organizationId_key" ON "Conversation"("id", "organizationId");
CREATE UNIQUE INDEX "Conversation_creation_request_key" ON "Conversation"("organizationId", "pullRequestId", "createdById", "requestId");
CREATE INDEX "Conversation_organizationId_pullRequestId_id_idx" ON "Conversation"("organizationId", "pullRequestId", "id");

CREATE TABLE "CollaborationTurn" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL,
  "initiatedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "headSha" VARCHAR(64) NOT NULL CHECK (length("headSha") > 0),
  "reviewRunId" TEXT,
  "status" "CollaborationTurnStatus" NOT NULL DEFAULT 'RECORDED',
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "requestId" VARCHAR(64) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("conversationId", "organizationId", "pullRequestId") REFERENCES "Conversation"("id", "organizationId", "pullRequestId") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("reviewRunId", "organizationId", "pullRequestId") REFERENCES "ReviewRun"("id", "organizationId", "pullRequestId") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CollaborationTurn_id_conversationId_organizationId_key" ON "CollaborationTurn"("id", "conversationId", "organizationId");
CREATE UNIQUE INDEX "CollaborationTurn_conversationId_sequence_key" ON "CollaborationTurn"("conversationId", "sequence");
CREATE UNIQUE INDEX "CollaborationTurn_conversationId_initiatedById_requestId_key" ON "CollaborationTurn"("conversationId", "initiatedById", "requestId");
CREATE INDEX "CollaborationTurn_organizationId_conversationId_idx" ON "CollaborationTurn"("organizationId", "conversationId");

CREATE TABLE "ConversationMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "kind" "ConversationMessageKind" NOT NULL DEFAULT 'HUMAN',
  "content" TEXT NOT NULL CHECK (length("content") BETWEEN 1 AND 8000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("turnId", "conversationId", "organizationId") REFERENCES "CollaborationTurn"("id", "conversationId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationMessage_conversationId_sequence_key" ON "ConversationMessage"("conversationId", "sequence");
CREATE INDEX "ConversationMessage_organizationId_conversationId_sequence_idx" ON "ConversationMessage"("organizationId", "conversationId", "sequence");
