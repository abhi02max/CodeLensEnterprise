import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const directory = join(__dirname, '../prisma/migrations');
test('3D prerequisite adds nullable base revision without historical backfill or proposal behavior', () => {
  const sql = readFileSync(
    join(directory, '20261003010000_exact_revision_foundation/migration.sql'),
    'utf8',
  );
  assert.match(sql, /ADD COLUMN "baseSha" VARCHAR\(40\)/);
  assert.match(sql, /"baseSha" IS NULL/);
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE|TRUNCATE|UPDATE|DEFAULT|NOT NULL|PatchProposal)\b/i);
});
test('applied 3C migration remains immutable', () => {
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(directory, '20261003000000_collaborator_execution/migration.sql')))
      .digest('hex'),
    '155ff9b3ce0e62eeb85e01a4d836241f074499746519375dcbd65e26eff0bc52',
  );
});
