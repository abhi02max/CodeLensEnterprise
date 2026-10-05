-- Bounded advisory history only. No existing data or migration is rewritten.
CREATE TABLE "ValidationAiReview" (
 "id" UUID PRIMARY KEY, "organizationId" TEXT NOT NULL, "repositoryId" TEXT NOT NULL,
 "pullRequestId" TEXT NOT NULL, "validationId" TEXT NOT NULL, "applicationId" TEXT NOT NULL,
 "proposalId" TEXT NOT NULL, "requestedById" TEXT NOT NULL, "requestId" UUID NOT NULL,
 "requestHash" VARCHAR(64) NOT NULL, "proposalRevision" INTEGER NOT NULL,
 "proposalDigest" VARCHAR(64) NOT NULL, "baseSha" VARCHAR(40) NOT NULL, "headSha" VARCHAR(40) NOT NULL,
 "snapshotDigest" VARCHAR(64) NOT NULL, "candidateDigest" VARCHAR(64) NOT NULL,
 "staticIds" TEXT[] NOT NULL, "mlComparisonId" UUID NOT NULL,
 "packetVersion" VARCHAR(80) NOT NULL, "promptVersion" VARCHAR(80) NOT NULL, "schemaVersion" VARCHAR(80) NOT NULL,
 "packetDigest" VARCHAR(64), "packetHeader" JSONB,
 "requestedProvider" VARCHAR(32) NOT NULL, "requestedModel" VARCHAR(128) NOT NULL,
 "configurationDigest" VARCHAR(64) NOT NULL, "reportedProvider" VARCHAR(32), "reportedModel" VARCHAR(128),
 "state" VARCHAR(16) NOT NULL DEFAULT 'QUEUED', "assessment" VARCHAR(24), "result" JSONB,
 "failureCategory" VARCHAR(64), "fence" UUID,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3),
 "deadlineAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
 UNIQUE ("id","organizationId"), UNIQUE ("organizationId","requestedById","requestId"),
 FOREIGN KEY ("validationId","organizationId") REFERENCES "ValidationRun"("id","organizationId") ON DELETE RESTRICT,
 FOREIGN KEY ("mlComparisonId","organizationId") REFERENCES "ValidationMlComparison"("id","organizationId") ON DELETE RESTRICT,
 CHECK ("state" IN ('QUEUED','PREPARING','RUNNING','COMPLETED','FAILED','CANCELLED')),
 CHECK (("state" IN ('QUEUED','PREPARING','RUNNING')) = ("completedAt" IS NULL)),
 CHECK ("baseSha" ~ '^[a-f0-9]{40}$' AND "headSha" ~ '^[a-f0-9]{40}$'),
 CHECK (cardinality("staticIds")=2),
 CHECK (("state"='COMPLETED') = ("result" IS NOT NULL AND "assessment" IS NOT NULL)),
 CHECK ("assessment" IS NULL OR "assessment" IN ('ACCEPTABLE','NEEDS_CHANGES','INCONCLUSIVE')),
 CHECK ("state" NOT IN ('RUNNING','COMPLETED') OR ("packetDigest" IS NOT NULL AND "packetHeader" IS NOT NULL)),
 CHECK ("result" IS NULL OR octet_length("result"::text)<=32768)
);
CREATE INDEX "ValidationAiReview_organizationId_validationId_createdAt_idx" ON "ValidationAiReview"("organizationId","validationId","createdAt");
CREATE INDEX "ValidationAiReview_state_deadlineAt_idx" ON "ValidationAiReview"("state","deadlineAt");
CREATE UNIQUE INDEX validation_ai_one_active ON "ValidationAiReview"("validationId") WHERE state IN ('QUEUED','PREPARING','RUNNING');
CREATE TABLE "ValidationAiReviewAttempt" (
 "id" UUID PRIMARY KEY, "reviewId" UUID NOT NULL, "organizationId" TEXT NOT NULL,
 "generation" INTEGER NOT NULL DEFAULT 1, "fence" UUID NOT NULL,
 "requests" INTEGER NOT NULL DEFAULT 0, "retries" INTEGER NOT NULL DEFAULT 0,
 "repairs" INTEGER NOT NULL DEFAULT 0, "reservedTokens" INTEGER NOT NULL DEFAULT 0,
 "promptTokens" INTEGER, "completionTokens" INTEGER, "unknownRequests" INTEGER NOT NULL DEFAULT 0,
 "durationMs" INTEGER NOT NULL DEFAULT 0, "failureCategory" VARCHAR(64),
 "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
 UNIQUE ("reviewId","generation"),
 FOREIGN KEY ("reviewId","organizationId") REFERENCES "ValidationAiReview"("id","organizationId") ON DELETE RESTRICT,
 CHECK (generation=1 AND requests BETWEEN 0 AND 2 AND retries BETWEEN 0 AND 1 AND repairs BETWEEN 0 AND 1),
 CHECK (retries+repairs<=1 AND "reservedTokens"=requests*2048),
 CHECK ("unknownRequests" BETWEEN 0 AND requests AND "durationMs">=0),
 CHECK (("promptTokens" IS NULL OR "promptTokens">=0) AND ("completionTokens" IS NULL OR "completionTokens">=0))
);
CREATE TABLE "ValidationAiEvidenceReference" (
 "reviewId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "evidenceId" VARCHAR(64) NOT NULL,
 "sourceId" VARCHAR(160) NOT NULL, "type" VARCHAR(32) NOT NULL, "trust" VARCHAR(32) NOT NULL,
 "contentDigest" VARCHAR(64) NOT NULL, "ordinal" INTEGER NOT NULL, "payload" JSONB NOT NULL,
 PRIMARY KEY ("reviewId","evidenceId"), UNIQUE ("reviewId","ordinal"),
 FOREIGN KEY ("reviewId","organizationId") REFERENCES "ValidationAiReview"("id","organizationId") ON DELETE RESTRICT,
 CHECK (ordinal BETWEEN 0 AND 99), CHECK ("evidenceId" ~ '^[a-f0-9]{64}$' AND "contentDigest" ~ '^[a-f0-9]{64}$'),
 CHECK (trust IN ('SERVER_LINEAGE','EXACT_REVISION_SOURCE','DETERMINISTIC_DERIVED','BROKER_OBSERVATION','UNTRUSTED_RUNNER_REPORT','ADVISORY_ML','HUMAN_DECISION')),
 CHECK (type IN ('LINEAGE','PATCH','DECISION','BROKER','RUNNER','STATIC_ANALYSIS','STATIC_FINDING','ML')),
 CHECK (payload->>'type'=type AND octet_length(payload::text)<=32768)
);
CREATE FUNCTION validation_ai_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "ValidationAiReview"%ROWTYPE; v "ValidationRun"%ROWTYPE; a "PatchApplication"%ROWTYPE; m "ValidationMlComparison"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI re-review history cannot be deleted'; END IF;
 IF TG_TABLE_NAME<>'ValidationAiReview' THEN
   SELECT * INTO r FROM "ValidationAiReview" WHERE id=NEW."reviewId" FOR UPDATE;
   IF r.id IS NULL OR r."organizationId"<>NEW."organizationId" THEN RAISE EXCEPTION 'Foreign AI evidence or attempt'; END IF;
   IF TG_TABLE_NAME='ValidationAiEvidenceReference' THEN
     IF TG_OP<>'INSERT' OR r.state<>'PREPARING' THEN RAISE EXCEPTION 'Sealed AI evidence is immutable'; END IF;
   ELSE
     IF r.state NOT IN ('PREPARING','RUNNING') OR NEW.fence IS DISTINCT FROM r.fence THEN RAISE EXCEPTION 'AI attempt fence rejected'; END IF;
     IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['requests','retries','repairs','reservedTokens','promptTokens','completionTokens','unknownRequests','durationMs','failureCategory','completedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['requests','retries','repairs','reservedTokens','promptTokens','completionTokens','unknownRequests','durationMs','failureCategory','completedAt']) OR OLD."completedAt" IS NOT NULL OR NEW.requests<OLD.requests OR NEW.retries<OLD.retries OR NEW.repairs<OLD.repairs OR NEW."durationMs"<OLD."durationMs") THEN RAISE EXCEPTION 'AI attempt mutation rejected'; END IF;
   END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.state NOT IN ('QUEUED','PREPARING','RUNNING') THEN RAISE EXCEPTION 'Terminal AI review is immutable'; END IF;
   IF (to_jsonb(NEW)-ARRAY['state','assessment','result','failureCategory','fence','startedAt','completedAt','packetDigest','packetHeader','reportedProvider','reportedModel']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','assessment','result','failureCategory','fence','startedAt','completedAt','packetDigest','packetHeader','reportedProvider','reportedModel']) THEN RAISE EXCEPTION 'AI lineage is immutable'; END IF;
   IF (OLD.fence IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence) OR (OLD."packetDigest" IS NOT NULL AND (NEW."packetDigest" IS DISTINCT FROM OLD."packetDigest" OR NEW."packetHeader" IS DISTINCT FROM OLD."packetHeader")) THEN RAISE EXCEPTION 'AI preparation cannot be repinned'; END IF;
   IF NOT ((OLD.state='QUEUED' AND NEW.state IN ('PREPARING','FAILED','CANCELLED')) OR (OLD.state='PREPARING' AND NEW.state IN ('RUNNING','FAILED','CANCELLED')) OR (OLD.state='RUNNING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))) THEN RAISE EXCEPTION 'AI transition rejected'; END IF;
 END IF;
 SELECT * INTO v FROM "ValidationRun" WHERE id=NEW."validationId" FOR SHARE;
 SELECT * INTO a FROM "PatchApplication" WHERE id=NEW."applicationId" FOR SHARE;
 SELECT * INTO m FROM "ValidationMlComparison" WHERE id=NEW."mlComparisonId" FOR SHARE;
 IF v.id IS NULL OR a.id IS NULL OR m.id IS NULL OR v."organizationId"<>NEW."organizationId" OR a."organizationId"<>NEW."organizationId" OR m."organizationId"<>NEW."organizationId" OR v."applicationId"<>a.id OR m."validationId"<>v.id OR v."repositoryId"<>NEW."repositoryId" OR v."pullRequestId"<>NEW."pullRequestId" OR v."proposalId"<>NEW."proposalId" OR v."proposalRevision"<>NEW."proposalRevision" OR v."proposalDigest"<>NEW."proposalDigest" OR v."headSha"<>NEW."headSha" OR a."baseSha"<>NEW."baseSha" OR v."snapshotDigest"<>NEW."snapshotDigest" OR v."candidateDigest"<>NEW."candidateDigest" OR m."candidateDigest"<>NEW."candidateDigest" THEN RAISE EXCEPTION 'AI lineage binding rejected'; END IF;
 IF NEW.state='COMPLETED' AND NEW."deadlineAt"<=clock_timestamp() THEN RAISE EXCEPTION 'Late AI finalization'; END IF;
 IF NEW.state IN ('RUNNING','COMPLETED') AND (SELECT count(*) FROM "ValidationAiEvidenceReference" WHERE "reviewId"=NEW.id) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'AI packet membership absent'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validation_ai_review_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationAiReview" FOR EACH ROW EXECUTE FUNCTION validation_ai_guard();
CREATE TRIGGER validation_ai_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationAiReviewAttempt" FOR EACH ROW EXECUTE FUNCTION validation_ai_guard();
CREATE TRIGGER validation_ai_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationAiEvidenceReference" FOR EACH ROW EXECUTE FUNCTION validation_ai_guard();
