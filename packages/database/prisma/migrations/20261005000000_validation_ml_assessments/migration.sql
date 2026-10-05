-- Advisory, source-free history. No previous observation or source is rewritten.
CREATE TABLE "ValidationMlComparison" (
  "id" UUID PRIMARY KEY, "organizationId" TEXT NOT NULL, "repositoryId" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL, "validationId" TEXT NOT NULL, "applicationId" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL, "requestedById" TEXT NOT NULL, "requestId" UUID NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL, "proposalRevision" INTEGER NOT NULL,
  "proposalDigest" VARCHAR(64) NOT NULL, "baseSha" VARCHAR(40) NOT NULL,
  "headSha" VARCHAR(40) NOT NULL, "snapshotDigest" VARCHAR(64) NOT NULL,
  "candidateDigest" VARCHAR(64) NOT NULL, "baseSourceDigest" VARCHAR(64),
  "frozenMetadata" JSONB, "frozenMetadataDigest" VARCHAR(64),
  "featureSchemaVersion" VARCHAR(80) NOT NULL, "extractorVersion" VARCHAR(80) NOT NULL,
  "diffPolicyVersion" VARCHAR(80) NOT NULL, "staticPolicyVersion" VARCHAR(80) NOT NULL,
  "textNormalizationVersion" VARCHAR(80) NOT NULL, "requestContractVersion" VARCHAR(80) NOT NULL,
  "modelIdentity" JSONB, "resultDigest" VARCHAR(64), "state" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
  "outcome" VARCHAR(16), "deltaTenths" INTEGER, "bandMovement" VARCHAR(16),
  "failureCategory" VARCHAR(64), "fence" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
  UNIQUE ("id","organizationId"), UNIQUE ("organizationId","requestedById","requestId"),
  FOREIGN KEY ("validationId","organizationId") REFERENCES "ValidationRun"("id","organizationId") ON DELETE RESTRICT,
  FOREIGN KEY ("applicationId","organizationId") REFERENCES "PatchApplication"("id","organizationId") ON DELETE RESTRICT,
  CHECK ("baseSha" ~ '^[a-f0-9]{40}$' AND "headSha" ~ '^[a-f0-9]{40}$'),
  CHECK ("state" IN ('QUEUED','PREPARING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  CHECK ("outcome" IS NULL OR "outcome" IN ('LOWER','UNCHANGED','HIGHER','INCOMPARABLE','UNAVAILABLE')),
  CHECK (("state" IN ('QUEUED','PREPARING','RUNNING')) = ("completedAt" IS NULL)),
  CHECK (("outcome" IN ('LOWER','UNCHANGED','HIGHER')) IS NOT TRUE OR
    ("state"='COMPLETED' AND "deltaTenths" IS NOT NULL AND "modelIdentity" IS NOT NULL AND "resultDigest" IS NOT NULL)),
  CHECK ("outcome" IS DISTINCT FROM 'LOWER' OR "deltaTenths"<0),
  CHECK ("outcome" IS DISTINCT FROM 'HIGHER' OR "deltaTenths">0),
  CHECK ("outcome" IS DISTINCT FROM 'UNCHANGED' OR "deltaTenths"=0),
  CHECK ("outcome" IS DISTINCT FROM 'UNAVAILABLE' OR "deltaTenths" IS NULL)
);
CREATE INDEX "ValidationMlComparison_organizationId_validationId_createdAt_idx" ON "ValidationMlComparison"("organizationId","validationId","createdAt");
CREATE INDEX "ValidationMlComparison_state_deadlineAt_idx" ON "ValidationMlComparison"("state","deadlineAt");
CREATE TABLE "ValidationMlAssessment" (
  "id" UUID PRIMARY KEY, "comparisonId" UUID NOT NULL, "organizationId" TEXT NOT NULL,
  "side" VARCHAR(8) NOT NULL CHECK ("side" IN ('ORIGINAL','PATCHED')),
  "featureDigest" VARCHAR(64), "features" JSONB, "staticResultDigest" VARCHAR(64),
  "availability" VARCHAR(16) NOT NULL CHECK ("availability" IN ('AVAILABLE','UNAVAILABLE')),
  "scoreTenths" INTEGER, "band" VARCHAR(16), "probabilityMicros" INTEGER,
  "confidenceMillis" INTEGER, "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failureCategory" VARCHAR(64), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("comparisonId","side"),
  FOREIGN KEY ("comparisonId","organizationId") REFERENCES "ValidationMlComparison"("id","organizationId") ON DELETE RESTRICT,
  CHECK ("availability"<>'AVAILABLE' OR ("scoreTenths" IS NOT NULL AND "band" IS NOT NULL AND "probabilityMicros" IS NOT NULL AND "confidenceMillis" IS NOT NULL AND "scoreTenths" BETWEEN 0 AND 1000 AND "band" IN ('LOW','MEDIUM','HIGH','CRITICAL') AND "probabilityMicros" BETWEEN 0 AND 1000000 AND "confidenceMillis" BETWEEN 0 AND 1000 AND "featureDigest" IS NOT NULL AND "features" IS NOT NULL)),
  CHECK ("availability"<>'UNAVAILABLE' OR ("scoreTenths" IS NULL AND "band" IS NULL AND "probabilityMicros" IS NULL AND "confidenceMillis" IS NULL))
);
CREATE FUNCTION validation_ml_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "ValidationRun"%ROWTYPE; a "PatchApplication"%ROWTYPE; c "ValidationMlComparison"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ML history cannot be deleted'; END IF;
  IF TG_TABLE_NAME='ValidationMlAssessment' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ML assessments are immutable'; END IF;
    SELECT * INTO c FROM "ValidationMlComparison" WHERE id=NEW."comparisonId" FOR UPDATE;
    IF c.id IS NULL OR c."organizationId"<>NEW."organizationId" OR c.state<>'RUNNING' OR c."deadlineAt"<=CURRENT_TIMESTAMP THEN RAISE EXCEPTION 'Late or foreign ML assessment rejected'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state NOT IN ('QUEUED','PREPARING','RUNNING') THEN RAISE EXCEPTION 'Terminal ML comparison is immutable'; END IF;
    IF (to_jsonb(NEW)-ARRAY['state','outcome','deltaTenths','bandMovement','failureCategory','fence','startedAt','completedAt','baseSourceDigest','frozenMetadata','frozenMetadataDigest','modelIdentity','resultDigest']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','outcome','deltaTenths','bandMovement','failureCategory','fence','startedAt','completedAt','baseSourceDigest','frozenMetadata','frozenMetadataDigest','modelIdentity','resultDigest']) THEN RAISE EXCEPTION 'ML binding is immutable'; END IF;
    IF (OLD.fence IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence) OR
       (OLD."frozenMetadataDigest" IS NOT NULL AND (NEW."frozenMetadataDigest" IS DISTINCT FROM OLD."frozenMetadataDigest" OR NEW."frozenMetadata" IS DISTINCT FROM OLD."frozenMetadata")) OR
       (OLD."baseSourceDigest" IS NOT NULL AND NEW."baseSourceDigest" IS DISTINCT FROM OLD."baseSourceDigest") THEN RAISE EXCEPTION 'ML preparation cannot be repinned'; END IF;
    IF NOT ((OLD.state='QUEUED' AND NEW.state IN ('PREPARING','FAILED','CANCELLED')) OR (OLD.state='PREPARING' AND NEW.state IN ('RUNNING','FAILED','CANCELLED')) OR (OLD.state='RUNNING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))) THEN RAISE EXCEPTION 'ML transition rejected'; END IF;
  END IF;
  SELECT * INTO r FROM "ValidationRun" WHERE id=NEW."validationId" FOR SHARE;
  SELECT * INTO a FROM "PatchApplication" WHERE id=NEW."applicationId" FOR SHARE;
  IF r.id IS NULL OR a.id IS NULL OR r."organizationId"<>NEW."organizationId" OR a."organizationId"<>NEW."organizationId" OR r."applicationId"<>a.id OR
    r."repositoryId"<>NEW."repositoryId" OR r."pullRequestId"<>NEW."pullRequestId" OR r."proposalId"<>NEW."proposalId" OR r."proposalRevision"<>NEW."proposalRevision" OR r."proposalDigest"<>NEW."proposalDigest" OR
    r."headSha"<>NEW."headSha" OR a."baseSha"<>NEW."baseSha" OR r."snapshotDigest"<>NEW."snapshotDigest" OR r."candidateDigest"<>NEW."candidateDigest" THEN RAISE EXCEPTION 'ML lineage binding rejected'; END IF;
  IF NEW.state='COMPLETED' THEN
    IF (SELECT count(*) FROM "ValidationMlAssessment" WHERE "comparisonId"=NEW.id)<>2 THEN RAISE EXCEPTION 'ML pair is incomplete'; END IF;
    IF NEW."deltaTenths" IS NOT NULL AND (SELECT count(*) FROM "ValidationMlAssessment" WHERE "comparisonId"=NEW.id AND availability='AVAILABLE')<>2 THEN RAISE EXCEPTION 'ML scores cannot compare unavailable observations'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validation_ml_comparison_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationMlComparison" FOR EACH ROW EXECUTE FUNCTION validation_ml_guard();
CREATE TRIGGER validation_ml_assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationMlAssessment" FOR EACH ROW EXECUTE FUNCTION validation_ml_guard();
