-- Source-free immutable static observations; no historical run is rewritten.
CREATE TABLE "ValidationStaticAnalysis" (
  "id" UUID PRIMARY KEY, "validationId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL, "side" VARCHAR(8) NOT NULL CHECK ("side" IN ('ORIGINAL','PATCHED')),
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('COMPLETE','UNSUPPORTED','TRUNCATED','TIMED_OUT','FAILED')),
  "reason" VARCHAR(64), "rulesetVersion" VARCHAR(80) NOT NULL, "fingerprintVersion" VARCHAR(80) NOT NULL,
  "rulesetDigest" VARCHAR(64) NOT NULL CHECK ("rulesetDigest" ~ '^[a-f0-9]{64}$'),
  "configurationDigest" VARCHAR(64) NOT NULL CHECK ("configurationDigest" ~ '^[a-f0-9]{64}$'),
  "sourceDigest" VARCHAR(64) NOT NULL CHECK ("sourceDigest" ~ '^[a-f0-9]{64}$'),
  "inputDigest" VARCHAR(64) NOT NULL CHECK ("inputDigest" ~ '^[a-f0-9]{64}$'),
  "resultDigest" VARCHAR(64) NOT NULL CHECK ("resultDigest" ~ '^[a-f0-9]{64}$'),
  "findingCount" INTEGER NOT NULL CHECK ("findingCount" BETWEEN 0 AND 500),
  "durationMs" INTEGER NOT NULL CHECK ("durationMs" BETWEEN 0 AND 30000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("id","organizationId"), UNIQUE ("validationId","side"),
  FOREIGN KEY ("validationId","organizationId") REFERENCES "ValidationRun"("id","organizationId") ON DELETE RESTRICT,
  FOREIGN KEY ("attemptId","validationId","organizationId") REFERENCES "ValidationAttempt"("id","validationId","organizationId") ON DELETE RESTRICT,
  CHECK ("status"='COMPLETE' OR "findingCount"=0)
);
CREATE TABLE "ValidationFinding" (
  "id" UUID PRIMARY KEY, "analysisId" UUID NOT NULL, "organizationId" TEXT NOT NULL,
  "analyzer" VARCHAR(40) NOT NULL CHECK ("analyzer" IN ('PATTERN_SCAN','SECRET_SCAN')),
  "ruleId" VARCHAR(120) NOT NULL, "severity" VARCHAR(16) NOT NULL CHECK ("severity" IN ('CRITICAL','HIGH','MEDIUM','LOW','INFO')),
  "category" VARCHAR(40) NOT NULL, "path" VARCHAR(512) NOT NULL,
  "startLine" INTEGER NOT NULL CHECK ("startLine">0), "endLine" INTEGER NOT NULL CHECK ("endLine">="startLine"),
  "message" VARCHAR(700) NOT NULL,
  "occurrenceFingerprint" VARCHAR(64) NOT NULL CHECK ("occurrenceFingerprint" ~ '^[a-f0-9]{64}$'),
  "relevantDigest" VARCHAR(64) NOT NULL CHECK ("relevantDigest" ~ '^[a-f0-9]{64}$'),
  "findingDigest" VARCHAR(64) NOT NULL CHECK ("findingDigest" ~ '^[a-f0-9]{64}$'),
  "classification" VARCHAR(16) NOT NULL CHECK ("classification" IN ('UNCHANGED','RESOLVED','INTRODUCED','CHANGED','INCOMPARABLE')),
  "comparability" VARCHAR(64) NOT NULL,
  "counterpartDigest" VARCHAR(64) CHECK ("counterpartDigest" ~ '^[a-f0-9]{64}$'),
  "diffRelation" VARCHAR(16) NOT NULL CHECK ("diffRelation" IN ('EDITED_RANGE','CHANGED_FILE','UNCHANGED_FILE')),
  UNIQUE ("analysisId","findingDigest"),
  FOREIGN KEY ("analysisId","organizationId") REFERENCES "ValidationStaticAnalysis"("id","organizationId") ON DELETE RESTRICT
);
CREATE INDEX "ValidationFinding_organizationId_analysisId_id_idx" ON "ValidationFinding"("organizationId","analysisId","id");
CREATE FUNCTION validation_static_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "ValidationRun"%ROWTYPE; a "ValidationStaticAnalysis"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Static validation history is immutable'; END IF;
  IF TG_TABLE_NAME='ValidationStaticAnalysis' THEN
    SELECT * INTO r FROM "ValidationRun" WHERE id=NEW."validationId" FOR UPDATE;
    IF r.id IS NULL OR r.state<>'RUNNING' OR r."organizationId"<>NEW."organizationId" OR r."deadlineAt"<=CURRENT_TIMESTAMP OR
      NEW."sourceDigest"<>(CASE WHEN NEW.side='ORIGINAL' THEN r."snapshotDigest" ELSE r."candidateDigest" END) THEN
      RAISE EXCEPTION 'Static validation binding rejected';
    END IF;
  ELSE
    SELECT * INTO a FROM "ValidationStaticAnalysis" WHERE id=NEW."analysisId" FOR UPDATE;
    SELECT * INTO r FROM "ValidationRun" WHERE id=a."validationId" FOR UPDATE;
    IF a.id IS NULL OR a.status<>'COMPLETE' OR a."organizationId"<>NEW."organizationId" OR r.state<>'RUNNING' OR r."deadlineAt"<=CURRENT_TIMESTAMP OR
      (SELECT count(*) FROM "ValidationFinding" WHERE "analysisId"=a.id)>=a."findingCount" THEN
      RAISE EXCEPTION 'Late or foreign static finding rejected';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validation_static_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationStaticAnalysis" FOR EACH ROW EXECUTE FUNCTION validation_static_guard();
CREATE TRIGGER validation_finding_guard BEFORE INSERT OR UPDATE OR DELETE ON "ValidationFinding" FOR EACH ROW EXECUTE FUNCTION validation_static_guard();
