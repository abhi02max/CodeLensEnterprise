-- Paired validation observations, never source bytes or executable configuration.
CREATE TABLE "ValidationRun" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "applicationId" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL, "repositoryId" TEXT NOT NULL, "pullRequestId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL, "turnId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "requestId" UUID NOT NULL, "requestHash" VARCHAR(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  "proposalRevision" INTEGER NOT NULL CHECK ("proposalRevision">0),
  "proposalDigest" VARCHAR(64) NOT NULL CHECK ("proposalDigest" ~ '^[a-f0-9]{64}$'),
  "headSha" VARCHAR(40) NOT NULL CHECK ("headSha" ~ '^[a-f0-9]{40}$'),
  "snapshotDigest" VARCHAR(64) NOT NULL CHECK ("snapshotDigest" ~ '^[a-f0-9]{64}$'),
  "candidateDigest" VARCHAR(64) NOT NULL CHECK ("candidateDigest" ~ '^[a-f0-9]{64}$'),
  "image" VARCHAR(71) NOT NULL CHECK ("image" ~ '^sha256:[a-f0-9]{64}$'),
  "bundleDigest" VARCHAR(64) NOT NULL CHECK ("bundleDigest" ~ '^[a-f0-9]{64}$'),
  "configurationDigest" VARCHAR(64) NOT NULL CHECK ("configurationDigest" ~ '^[a-f0-9]{64}$'),
  "profiles" TEXT[] NOT NULL CHECK (cardinality("profiles") BETWEEN 1 AND 2 AND "profiles" <@ ARRAY['typescript-typecheck-v1','vitest-unit-v1']::TEXT[]),
  "state" VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK ("state" IN ('QUEUED','PREPARING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  "outcome" VARCHAR(32) CHECK ("outcome" IN ('BOTH_PASS','ORIGINAL_PASS_PATCHED_FAIL','ORIGINAL_FAIL_PATCHED_PASS','BOTH_FAIL','UNSUPPORTED','INCONCLUSIVE')),
  "cleanup" VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED' CHECK ("cleanup" IN ('NOT_STARTED','DISPOSED','UNCERTAIN')),
  "failureCategory" VARCHAR(64), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
  UNIQUE ("id","organizationId"), UNIQUE ("organizationId","requestedById","requestId"),
  FOREIGN KEY ("applicationId","organizationId") REFERENCES "PatchApplication"("id","organizationId") ON DELETE RESTRICT,
  CHECK ("deadlineAt">"createdAt" AND "deadlineAt"<="createdAt"+interval '12 minutes'),
  CHECK (("state" IN ('COMPLETED','FAILED','CANCELLED')) = ("completedAt" IS NOT NULL)),
  CHECK ("state"<>'COMPLETED' OR ("cleanup"='DISPOSED' AND "outcome" IS NOT NULL AND "completedAt"<="deadlineAt"))
);
CREATE INDEX "ValidationRun_organizationId_applicationId_id_idx" ON "ValidationRun"("organizationId","applicationId","id");
CREATE INDEX "ValidationRun_state_deadlineAt_idx" ON "ValidationRun"("state","deadlineAt");
CREATE UNIQUE INDEX "one_active_validation" ON "ValidationRun"("applicationId") WHERE "state" IN ('QUEUED','PREPARING','RUNNING') OR "cleanup"='UNCERTAIN';
CREATE TABLE "ValidationAttempt" (
  "id" TEXT PRIMARY KEY, "validationId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1 CHECK ("generation"=1), "jobId" VARCHAR(200) NOT NULL UNIQUE,
  "fence" UUID, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  UNIQUE ("validationId","generation"), UNIQUE ("id","validationId","organizationId"),
  FOREIGN KEY ("validationId","organizationId") REFERENCES "ValidationRun"("id","organizationId") ON DELETE RESTRICT
);
CREATE TABLE "ValidationStep" (
  "id" TEXT PRIMARY KEY, "validationId" TEXT NOT NULL, "attemptId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "profile" VARCHAR(40) NOT NULL CHECK ("profile" IN ('typescript-typecheck-v1','vitest-unit-v1')),
  "profileVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("profileVersion"=1),
  "side" VARCHAR(8) NOT NULL CHECK ("side" IN ('ORIGINAL','PATCHED')),
  "inputDigest" VARCHAR(64) NOT NULL CHECK ("inputDigest" ~ '^[a-f0-9]{64}$'),
  "resultDigest" VARCHAR(64) NOT NULL CHECK ("resultDigest" ~ '^[a-f0-9]{64}$'),
  "brokerNonce" UUID NOT NULL UNIQUE,
  "status" VARCHAR(32) NOT NULL CHECK ("status" IN ('VALIDATION_EXECUTED','INFRASTRUCTURE_FAILED','UNSUPPORTED','CANCELLED')),
  "outcome" VARCHAR(16) NOT NULL CHECK ("outcome" IN ('PASS','FAIL','UNSUPPORTED','INCONCLUSIVE')),
  "observed" JSONB NOT NULL CHECK (octet_length("observed"::TEXT)<=60000),
  "runnerReported" JSONB NOT NULL CHECK (octet_length("runnerReported"::TEXT)<=4096 AND "runnerReported"->>'trusted'='false'),
  "startedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("attemptId","profile","side"),
  FOREIGN KEY ("attemptId","validationId","organizationId") REFERENCES "ValidationAttempt"("id","validationId","organizationId") ON DELETE RESTRICT
);
CREATE INDEX "ValidationStep_organizationId_validationId_idx" ON "ValidationStep"("organizationId","validationId");

CREATE FUNCTION validation_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "PatchApplication"%ROWTYPE; p "PatchProposal"%ROWTYPE; t "PatchApplicationAttempt"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Validation history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO a FROM "PatchApplication" WHERE id=NEW."applicationId" FOR SHARE;
    SELECT * INTO p FROM "PatchProposal" WHERE id=a."proposalId" FOR SHARE;
    SELECT * INTO t FROM "PatchApplicationAttempt" WHERE "applicationId"=a.id AND status='APPLIED' AND cleanup='DISPOSED';
    IF a.id IS NULL OR p.id IS NULL OR t.id IS NULL OR a.status<>'APPLIED' OR a.cleanup<>'DISPOSED' OR p.status<>'ACCEPTED' OR
      (NEW."organizationId",NEW."proposalId",NEW."repositoryId",NEW."pullRequestId",NEW."conversationId",NEW."turnId",NEW."headSha",NEW."proposalRevision",NEW."proposalDigest",NEW."snapshotDigest",NEW."candidateDigest") IS DISTINCT FROM
      (a."organizationId",a."proposalId",a."repositoryId",a."pullRequestId",a."conversationId",a."turnId",a."headSha",a."proposalRevision",a."proposalDigest",t."snapshotDigest",t."manifestDigest") THEN
      RAISE EXCEPTION 'Validation application binding rejected';
    END IF;
    IF NEW.state<>'QUEUED' OR NEW.outcome IS NOT NULL OR NEW.cleanup<>'NOT_STARTED' THEN RAISE EXCEPTION 'Invalid initial validation state'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','outcome','cleanup','failureCategory','completedAt','updatedAt']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','outcome','cleanup','failureCategory','completedAt','updatedAt']) THEN RAISE EXCEPTION 'Validation identity is immutable'; END IF;
    IF OLD.state IN ('COMPLETED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal validation is immutable'; END IF;
    IF NOT (NEW.state=OLD.state OR (OLD.state='QUEUED' AND NEW.state IN ('PREPARING','FAILED','CANCELLED')) OR
      (OLD.state='PREPARING' AND NEW.state IN ('RUNNING','FAILED','CANCELLED')) OR
      (OLD.state='RUNNING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))) THEN RAISE EXCEPTION 'Invalid validation transition'; END IF;
  END IF;
  NEW."updatedAt"=CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER validation_run_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationRun" FOR EACH ROW EXECUTE FUNCTION validation_run_guard();
CREATE FUNCTION validation_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Validation attempt history is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['fence','startedAt','completedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['fence','startedAt','completedAt']) OR
    (OLD.fence IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence) OR OLD."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Validation attempt identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validation_attempt_guard BEFORE UPDATE OR DELETE ON "ValidationAttempt" FOR EACH ROW EXECUTE FUNCTION validation_attempt_guard();
CREATE FUNCTION validation_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "ValidationRun"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Validation observations are immutable'; END IF;
  SELECT * INTO r FROM "ValidationRun" WHERE id=NEW."validationId" FOR UPDATE;
  IF r.state<>'RUNNING' OR r."organizationId"<>NEW."organizationId" OR NOT NEW.profile=ANY(r.profiles) OR r."deadlineAt"<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Late or foreign validation observation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validation_step_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationStep" FOR EACH ROW EXECUTE FUNCTION validation_step_guard();
