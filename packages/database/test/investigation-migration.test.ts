import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { EXPECTED_TABLES } from '../src/schema-compatibility';
const sql = readFileSync(
  join(__dirname, '../prisma/migrations/20261002010000_investigation_foundation/migration.sql'),
  'utf8',
);
test('3B is additive and separate from analysis ToolRun', () => {
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((x) => x[1]),
    ['CollaborationToolCall', 'EvidenceReference'],
  );
  assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.doesNotMatch(sql, /CREATE TABLE "ReviewRun"/);
});
test('3B constrains tenant parents, replay identity, sequence and output bytes', () => {
  assert.match(sql, /REFERENCES "CollaborationTurn"\("id", "organizationId", "pullRequestId"\)/);
  assert.match(sql, /REFERENCES "CollaborationToolCall"\("id", "turnId", "organizationId"\)/);
  assert.match(sql, /"sequence" BETWEEN 1 AND 8/);
  assert.match(sql, /"turnId", "requestedById", "requestId"/);
  assert.match(sql, /octet_length\("excerpt"\) <= 16384/);
});
test('applied baseline/3A migration bytes and legacy eligibility remain unchanged', () => {
  for (const [name, expected] of [
    ['0_baseline', 'e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab'],
    [
      '20261002000000_conversation_foundation',
      'b9612e1f2663739f7d65cbeedff30a9ba2e34e4f8c9d36b3cb24cf7f7afb100d',
    ],
  ]) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(__dirname, `../prisma/migrations/${name}/migration.sql`)))
        .digest('hex'),
      expected,
    );
  }
  assert.ok(!EXPECTED_TABLES.includes('CollaborationToolCall'));
  assert.ok(!EXPECTED_TABLES.includes('EvidenceReference'));
});
