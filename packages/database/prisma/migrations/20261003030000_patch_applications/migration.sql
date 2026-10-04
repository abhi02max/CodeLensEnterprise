-- Application records contain identities and hashes, never candidate source or patches.
CREATE TABLE "PatchApplication" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "requestId" UUID NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  "proposalRevision" INTEGER NOT NULL CHECK ("proposalRevision" > 0),
  "proposalDigest" VARCHAR(64) NOT NULL CHECK ("proposalDigest" ~ '^[a-f0-9]{64}$'),
  "headSha" VARCHAR(40) NOT NULL CHECK ("headSha" ~ '^[a-f0-9]{40}$'),
  "baseSha" VARCHAR(40) NOT NULL CHECK ("baseSha" ~ '^[a-f0-9]{40}$'),
  "executorImage" VARCHAR(71) NOT NULL CHECK ("executorImage" ~ '^sha256:[a-f0-9]{64}$'),
  "policyVersion" VARCHAR(40) NOT NULL CHECK ("policyVersion" = 'restricted-materialization-v1'),
  "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','PREPARING','APPLYING','APPLIED','FAILED','CANCELLED')),
  "cleanup" VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED' CHECK ("cleanup" IN ('NOT_STARTED','UNCERTAIN','DISPOSED')),
  "failureCategory" VARCHAR(64),
  "traceId" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PatchApplication_id_organizationId_key" UNIQUE ("id","organizationId"),
  CONSTRAINT "PatchApplication_organizationId_requestedById_requestId_key" UNIQUE ("organizationId","requestedById","requestId"),
  FOREIGN KEY ("proposalId","organizationId","turnId") REFERENCES "PatchProposal"("id","organizationId","turnId") ON DELETE RESTRICT,
  CHECK ("deadlineAt" > "createdAt" AND "deadlineAt" <= "createdAt" + interval '150 seconds'),
  CHECK (("status" IN ('APPLIED','FAILED','CANCELLED')) = ("completedAt" IS NOT NULL)),
  CHECK ("status" <> 'APPLIED' OR ("cleanup" = 'DISPOSED' AND "failureCategory" IS NULL AND "completedAt" <= "deadlineAt"))
);
CREATE INDEX "PatchApplication_organizationId_proposalId_id_idx" ON "PatchApplication"("organizationId","proposalId","id");
CREATE INDEX "PatchApplication_status_deadlineAt_idx" ON "PatchApplication"("status","deadlineAt");
CREATE UNIQUE INDEX "one_active_patch_application" ON "PatchApplication"("proposalId") WHERE "status" IN ('QUEUED','PREPARING','APPLYING');

CREATE TABLE "PatchApplicationAttempt" (
  "id" TEXT PRIMARY KEY,
  "applicationId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL CHECK ("generation" = 1),
  "jobId" VARCHAR(200) NOT NULL UNIQUE,
  "fence" UUID,
  "brokerNonce" UUID NOT NULL UNIQUE,
  "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','PREPARING','APPLYING','APPLIED','FAILED','CANCELLED')),
  "cleanup" VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED' CHECK ("cleanup" IN ('NOT_STARTED','UNCERTAIN','DISPOSED')),
  "failureCategory" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "snapshotDigest" VARCHAR(64),
  "manifestDigest" VARCHAR(64),
  CONSTRAINT "PatchApplicationAttempt_applicationId_generation_key" UNIQUE ("applicationId","generation"),
  CONSTRAINT "PatchApplicationAttempt_id_applicationId_organizationId_key" UNIQUE ("id","applicationId","organizationId"),
  FOREIGN KEY ("applicationId","organizationId") REFERENCES "PatchApplication"("id","organizationId") ON DELETE RESTRICT,
  CHECK (("status" IN ('APPLIED','FAILED','CANCELLED')) = ("completedAt" IS NOT NULL)),
  CHECK ("snapshotDigest" IS NULL OR "snapshotDigest" ~ '^[a-f0-9]{64}$'),
  CHECK ("manifestDigest" IS NULL OR "manifestDigest" ~ '^[a-f0-9]{64}$'),
  CHECK ("status" NOT IN ('PREPARING','APPLYING','APPLIED') OR ("fence" IS NOT NULL AND "startedAt" IS NOT NULL)),
  CHECK ("status" <> 'APPLIED' OR ("cleanup" = 'DISPOSED' AND "manifestDigest" IS NOT NULL AND "snapshotDigest" IS NOT NULL AND "failureCategory" IS NULL AND "completedAt" <= "deadlineAt"))
);
CREATE INDEX "PatchApplicationAttempt_status_deadlineAt_idx" ON "PatchApplicationAttempt"("status","deadlineAt");
CREATE UNIQUE INDEX "one_active_patch_application_attempt" ON "PatchApplicationAttempt"("applicationId") WHERE "status" IN ('QUEUED','PREPARING','APPLYING');

CREATE TABLE "PatchApplicationFileResult" (
  "id" TEXT PRIMARY KEY,
  "applicationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "path" VARCHAR(500) NOT NULL,
  "oldBlobSha" VARCHAR(40) NOT NULL CHECK ("oldBlobSha" ~ '^[a-f0-9]{40}$'),
  "oldContentHash" VARCHAR(64) NOT NULL CHECK ("oldContentHash" ~ '^[a-f0-9]{64}$'),
  "contentHash" VARCHAR(64) NOT NULL CHECK ("contentHash" ~ '^[a-f0-9]{64}$'),
  "byteLength" INTEGER NOT NULL CHECK ("byteLength" >= 0 AND "byteLength" <= 20971520),
  CONSTRAINT "PatchApplicationFileResult_attemptId_path_key" UNIQUE ("attemptId","path"),
  FOREIGN KEY ("attemptId","applicationId","organizationId") REFERENCES "PatchApplicationAttempt"("id","applicationId","organizationId") ON DELETE RESTRICT
);

CREATE FUNCTION protect_patch_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Application history is immutable'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','cleanup','failureCategory','completedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','cleanup','failureCategory','completedAt']) THEN
    RAISE EXCEPTION 'Application identity is immutable';
  END IF;
  IF OLD."status" IN ('APPLIED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal application is immutable';
  END IF;
  IF NOT (NEW."status" = OLD."status" OR
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('PREPARING','FAILED','CANCELLED')) OR
    (OLD."status" = 'PREPARING' AND NEW."status" IN ('APPLYING','FAILED','CANCELLED')) OR
    (OLD."status" = 'APPLYING' AND NEW."status" IN ('APPLIED','FAILED','CANCELLED'))) THEN
    RAISE EXCEPTION 'Invalid application transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_patch_application BEFORE UPDATE OR DELETE ON "PatchApplication" FOR EACH ROW EXECUTE FUNCTION protect_patch_application();

CREATE FUNCTION protect_patch_application_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Application attempt history is immutable'; END IF;
  IF (to_jsonb(NEW) - ARRAY['fence','status','cleanup','failureCategory','startedAt','completedAt','snapshotDigest','manifestDigest']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['fence','status','cleanup','failureCategory','startedAt','completedAt','snapshotDigest','manifestDigest']) THEN
    RAISE EXCEPTION 'Attempt identity is immutable';
  END IF;
  IF OLD."status" IN ('APPLIED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal attempt is immutable';
  END IF;
  IF OLD."fence" IS NOT NULL AND NEW."fence" IS DISTINCT FROM OLD."fence" THEN
    RAISE EXCEPTION 'Execution fence cannot be replaced';
  END IF;
  IF NOT (NEW."status" = OLD."status" OR
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('PREPARING','FAILED','CANCELLED')) OR
    (OLD."status" = 'PREPARING' AND NEW."status" IN ('APPLYING','FAILED','CANCELLED')) OR
    (OLD."status" = 'APPLYING' AND NEW."status" IN ('APPLIED','FAILED','CANCELLED'))) THEN
    RAISE EXCEPTION 'Invalid attempt transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_patch_application_attempt BEFORE UPDATE OR DELETE ON "PatchApplicationAttempt" FOR EACH ROW EXECUTE FUNCTION protect_patch_application_attempt();

CREATE FUNCTION verify_patch_application_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "PatchProposal"%ROWTYPE;
BEGIN
  SELECT * INTO p FROM "PatchProposal" WHERE "id"=NEW."proposalId" FOR UPDATE;
  IF NOT FOUND OR p."status" <> 'ACCEPTED' OR p."organizationId" <> NEW."organizationId" OR
    p."turnId" <> NEW."turnId" OR p."repositoryId" <> NEW."repositoryId" OR
    p."pullRequestId" <> NEW."pullRequestId" OR p."conversationId" <> NEW."conversationId" OR
    p."revision" <> NEW."proposalRevision" OR p."digest" <> NEW."proposalDigest" OR
    p."headSha" <> NEW."headSha" OR p."baseSha" <> NEW."baseSha" THEN
    RAISE EXCEPTION 'Application proposal scope or eligibility mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verify_patch_application_scope BEFORE INSERT ON "PatchApplication" FOR EACH ROW EXECUTE FUNCTION verify_patch_application_scope();

CREATE FUNCTION verify_patch_application_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "PatchApplication"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "PatchApplication" WHERE "id"=NEW."applicationId";
  IF NOT FOUND OR a."organizationId" <> NEW."organizationId" OR a."deadlineAt" <> NEW."deadlineAt" OR
    NEW."status" <> 'QUEUED' OR NEW."fence" IS NOT NULL THEN
    RAISE EXCEPTION 'Attempt scope or initial state mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verify_patch_application_attempt BEFORE INSERT ON "PatchApplicationAttempt" FOR EACH ROW EXECUTE FUNCTION verify_patch_application_attempt();

CREATE FUNCTION protect_patch_application_file_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Application file results are immutable';
END $$;
CREATE TRIGGER protect_patch_application_file_result BEFORE UPDATE OR DELETE ON "PatchApplicationFileResult" FOR EACH ROW EXECUTE FUNCTION protect_patch_application_file_result();
