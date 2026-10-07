import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('PR diff provenance migration is additive and does not fabricate history', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261007000000_pr_diff_provenance/migration.sql'),
    'utf8',
  );
  for (const field of ['diffBaseSha', 'diffHeadSha', 'diffMergeBaseSha', 'diffVerifiedAt']) {
    assert.match(sql, new RegExp(`ADD COLUMN "${field}" (?:TEXT|TIMESTAMP\\(3\\));?[,;]?`));
    assert.doesNotMatch(sql, new RegExp(`ADD COLUMN "${field}"[^;\\n]*(?:NOT NULL|DEFAULT)`));
  }
  assert.match(sql, /CREATE TABLE "PullRequestImportFence"/);
  assert.match(sql, /PRIMARY KEY \("repositoryId", "number"\)/);
  assert.match(sql, /"generation" BIGINT NOT NULL DEFAULT 0/);
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP|TRUNCATE)\b/im);
});
