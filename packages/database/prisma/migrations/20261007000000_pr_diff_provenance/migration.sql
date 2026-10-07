ALTER TABLE "PullRequest"
  ADD COLUMN "diffBaseSha" TEXT,
  ADD COLUMN "diffHeadSha" TEXT,
  ADD COLUMN "diffMergeBaseSha" TEXT,
  ADD COLUMN "diffVerifiedAt" TIMESTAMP(3);

CREATE TABLE "PullRequestImportFence" (
  "repositoryId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "PullRequestImportFence_pkey" PRIMARY KEY ("repositoryId", "number"),
  CONSTRAINT "PullRequestImportFence_repositoryId_fkey" FOREIGN KEY ("repositoryId")
    REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
