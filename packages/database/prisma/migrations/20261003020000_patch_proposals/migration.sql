-- Immutable proposal data; only human decision metadata can change.
CREATE TABLE "PatchProposal" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "repositoryId" TEXT NOT NULL,
 "pullRequestId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "turnId" TEXT NOT NULL,
 "attemptId" TEXT, "parentId" TEXT, "authorId" TEXT NOT NULL, "authorType" VARCHAR(8) NOT NULL,
 "provider" VARCHAR(32), "model" VARCHAR(128), "requestId" VARCHAR(64) NOT NULL,
 "requestHash" VARCHAR(64) NOT NULL, "headSha" VARCHAR(40) NOT NULL, "baseSha" VARCHAR(40) NOT NULL,
 "revision" INTEGER NOT NULL, "summary" VARCHAR(300) NOT NULL, "rationale" TEXT NOT NULL,
 "limitations" TEXT NOT NULL, "digest" VARCHAR(64) NOT NULL, "fileCount" INTEGER NOT NULL,
 "changedLines" INTEGER NOT NULL, "status" VARCHAR(16) NOT NULL DEFAULT 'PROPOSED',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "decidedAt" TIMESTAMP(3),
 "decidedById" TEXT, "decisionRequestId" VARCHAR(64),
 CONSTRAINT "PatchProposal_bounds" CHECK ("fileCount" BETWEEN 1 AND 10 AND "changedLines" BETWEEN 1 AND 500 AND "revision">0),
 CONSTRAINT "PatchProposal_pins" CHECK ("headSha" ~ '^[a-f0-9]{40}$' AND "baseSha" ~ '^[a-f0-9]{40}$'),
 CONSTRAINT "PatchProposal_author" CHECK ("authorType" IN ('AI','HUMAN')),
 CONSTRAINT "PatchProposal_status" CHECK ("status" IN ('PROPOSED','ACCEPTED','REJECTED','SUPERSEDED')),
 CONSTRAINT "PatchProposal_turnId_conversationId_organizationId_fkey" FOREIGN KEY ("turnId","conversationId","organizationId") REFERENCES "CollaborationTurn"("id","conversationId","organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "PatchProposal_repo_scope" FOREIGN KEY ("repositoryId","organizationId") REFERENCES "Repository"("id","organizationId") ON DELETE RESTRICT,
 CONSTRAINT "PatchProposal_pr_scope" FOREIGN KEY ("pullRequestId","organizationId") REFERENCES "PullRequest"("id","organizationId") ON DELETE RESTRICT,
 CONSTRAINT "PatchProposal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT,
 CONSTRAINT "PatchProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT,
 CONSTRAINT "PatchProposal_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CollaborationAttempt"("id") ON DELETE RESTRICT,
 CONSTRAINT "PatchProposal_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PatchProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PatchProposal_attemptId_key" ON "PatchProposal"("attemptId");
CREATE UNIQUE INDEX "PatchProposal_parentId_key" ON "PatchProposal"("parentId");
CREATE UNIQUE INDEX "PatchProposal_id_organizationId_turnId_key" ON "PatchProposal"("id","organizationId","turnId");
CREATE UNIQUE INDEX "PatchProposal_turnId_authorId_requestId_key" ON "PatchProposal"("turnId","authorId","requestId");
CREATE INDEX "PatchProposal_organizationId_conversationId_createdAt_idx" ON "PatchProposal"("organizationId","conversationId","createdAt");
ALTER TABLE "CollaborationTurn" ADD COLUMN "revisionOfProposalId" TEXT;
ALTER TABLE "CollaborationTurn" ADD CONSTRAINT "CollaborationTurn_revisionOfProposalId_fkey" FOREIGN KEY ("revisionOfProposalId") REFERENCES "PatchProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "PatchProposalFile" (
 "id" TEXT PRIMARY KEY, "proposalId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
 "turnId" TEXT NOT NULL, "path" VARCHAR(500) NOT NULL, "operation" VARCHAR(8) NOT NULL DEFAULT 'MODIFY',
 "oldBlobSha" VARCHAR(40) NOT NULL, "oldContentHash" VARCHAR(64) NOT NULL,
 "newContentHash" VARCHAR(64) NOT NULL, "diff" TEXT NOT NULL, "edits" JSONB NOT NULL,
 "evidenceIds" TEXT[] NOT NULL,
 CONSTRAINT "PatchProposalFile_modify_only" CHECK ("operation"='MODIFY'),
 CONSTRAINT "PatchProposalFile_proposalId_organizationId_turnId_fkey" FOREIGN KEY ("proposalId","organizationId","turnId") REFERENCES "PatchProposal"("id","organizationId","turnId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PatchProposalFile_proposalId_path_key" ON "PatchProposalFile"("proposalId","path");
CREATE UNIQUE INDEX "EvidenceReference_id_organizationId_turnId_key" ON "EvidenceReference"("id","organizationId","turnId");
CREATE TABLE "PatchProposalEvidence" (
 "proposalId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "turnId" TEXT NOT NULL, "evidenceId" TEXT NOT NULL,
 PRIMARY KEY ("proposalId","evidenceId"),
 CONSTRAINT "PatchProposalEvidence_proposalId_organizationId_turnId_fkey" FOREIGN KEY ("proposalId","organizationId","turnId") REFERENCES "PatchProposal"("id","organizationId","turnId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "PatchProposalEvidence_evidenceId_organizationId_turnId_fkey" FOREIGN KEY ("evidenceId","organizationId","turnId") REFERENCES "EvidenceReference"("id","organizationId","turnId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE FUNCTION protect_patch_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable patch data cannot be deleted'; END IF;
 IF TG_TABLE_NAME <> 'PatchProposal' THEN RAISE EXCEPTION 'Immutable patch content cannot be updated'; END IF;
 IF (to_jsonb(OLD)-ARRAY['status','decidedAt','decidedById','decisionRequestId']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','decidedAt','decidedById','decisionRequestId']) THEN
   RAISE EXCEPTION 'Immutable proposal content cannot be updated';
 END IF;
 IF NOT ((OLD."status"='PROPOSED' AND NEW."status" IN ('ACCEPTED','REJECTED','SUPERSEDED')) OR
         (OLD."status" IN ('ACCEPTED','REJECTED') AND NEW."status"='SUPERSEDED')) THEN
   RAISE EXCEPTION 'Invalid proposal lifecycle transition';
 END IF;
 IF NEW."status" IN ('ACCEPTED','REJECTED') AND (NEW."decidedAt" IS NULL OR NEW."decidedById" IS NULL) THEN
   RAISE EXCEPTION 'Human decision metadata is required';
 END IF;
 IF NEW."status"='SUPERSEDED' AND
   ROW(NEW."decidedAt",NEW."decidedById",NEW."decisionRequestId") IS DISTINCT FROM
   ROW(OLD."decidedAt",OLD."decidedById",OLD."decisionRequestId") THEN
   RAISE EXCEPTION 'Supersession cannot rewrite earlier human decision metadata';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_proposal BEFORE UPDATE OR DELETE ON "PatchProposal" FOR EACH ROW EXECUTE FUNCTION protect_patch_data();
CREATE TRIGGER protect_proposal_file BEFORE UPDATE OR DELETE ON "PatchProposalFile" FOR EACH ROW EXECUTE FUNCTION protect_patch_data();
CREATE TRIGGER protect_proposal_evidence BEFORE UPDATE OR DELETE ON "PatchProposalEvidence" FOR EACH ROW EXECUTE FUNCTION protect_patch_data();

CREATE FUNCTION verify_patch_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."status"<>'PROPOSED' OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL THEN
   RAISE EXCEPTION 'New proposals must be unaccepted';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "CollaborationTurn" t JOIN "PullRequest" p ON p.id=t."pullRequestId"
   WHERE t.id=NEW."turnId" AND t."organizationId"=NEW."organizationId"
   AND t."conversationId"=NEW."conversationId" AND p.id=NEW."pullRequestId"
   AND p."organizationId"=NEW."organizationId" AND p."repositoryId"=NEW."repositoryId"
   AND t."headSha"=NEW."headSha" AND t."baseSha"=NEW."baseSha") THEN
   RAISE EXCEPTION 'Proposal scope or pinned revision mismatch';
 END IF;
 IF NEW."attemptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CollaborationAttempt" a
   WHERE a.id=NEW."attemptId" AND a."turnId"=NEW."turnId" AND a."organizationId"=NEW."organizationId") THEN
   RAISE EXCEPTION 'Proposal attempt scope mismatch';
 END IF;
 IF NEW."parentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PatchProposal" p
   WHERE p.id=NEW."parentId" AND p."organizationId"=NEW."organizationId"
   AND p."conversationId"=NEW."conversationId" AND p."pullRequestId"=NEW."pullRequestId"
   AND p."repositoryId"=NEW."repositoryId" AND p."headSha"=NEW."headSha" AND p."baseSha"=NEW."baseSha"
   AND NEW."revision"=p."revision"+1) THEN
   RAISE EXCEPTION 'Proposal ancestry scope mismatch';
 END IF;
 IF NEW."parentId" IS NULL AND NEW."revision"<>1 THEN RAISE EXCEPTION 'Initial proposal revision must be one'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER verify_proposal_scope BEFORE INSERT ON "PatchProposal" FOR EACH ROW EXECUTE FUNCTION verify_patch_scope();
