import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const directory = join(__dirname, '../prisma/migrations');
const sql = readFileSync(
  join(directory, '20261003000000_collaborator_execution/migration.sql'),
  'utf8',
);
test('3C only adds execution state, attempts and assistant metadata', () => {
  assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.match(sql, /REFERENCES "CollaborationTurn"\("id", "organizationId", "pullRequestId"\)/);
  assert.match(sql, /"providerRequests" BETWEEN 0 AND 5/);
  assert.match(sql, /"ConversationMessage"\("turnId", "kind"\)/);
  assert.doesNotMatch(sql, /reasoning|prompt|credential|patch/i);
});
test('all applied migrations retain immutable byte hashes', () => {
  for (const [name, hash] of [
    ['0_baseline', 'e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab'],
    [
      '20261002000000_conversation_foundation',
      'b9612e1f2663739f7d65cbeedff30a9ba2e34e4f8c9d36b3cb24cf7f7afb100d',
    ],
    [
      '20261002010000_investigation_foundation',
      '04389bfda10486cdad8dd270a0a9bfa3555941d783a2b78d1acf7f4259e07a49',
    ],
  ])
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(directory, `${name}/migration.sql`)))
        .digest('hex'),
      hash,
    );
});
