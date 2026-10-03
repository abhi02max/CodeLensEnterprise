ALTER TABLE "CollaborationTurn" ADD COLUMN "baseSha" VARCHAR(40);
ALTER TABLE "CollaborationTurn" ADD CONSTRAINT "CollaborationTurn_baseSha_check"
  CHECK ("baseSha" IS NULL OR "baseSha" ~ '^[0-9a-f]{40}$');
