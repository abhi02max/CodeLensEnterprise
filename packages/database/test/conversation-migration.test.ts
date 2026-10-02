import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { EXPECTED_TABLES } from '../src/schema-compatibility';

const sql = readFileSync(
  join(__dirname, '../prisma/migrations/20261002000000_conversation_foundation/migration.sql'),
  'utf8',
);
test('conversation migration adds only foundation entities without destructive statements', () => {
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]),
    ['Conversation', 'CollaborationTurn', 'ConversationMessage'],
  );
  assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.match(sql, /REFERENCES "PullRequest"\("id", "organizationId"\)/);
  assert.match(sql, /REFERENCES "Conversation"\("id", "organizationId", "pullRequestId"\)/);
  assert.match(sql, /REFERENCES "ReviewRun"\("id", "organizationId", "pullRequestId"\)/);
  assert.match(sql, /REFERENCES "CollaborationTurn"\("id", "conversationId", "organizationId"\)/);
});
test('ordering, request identity and message bounds have database constraints', () => {
  assert.match(sql, /"ConversationMessage"\("conversationId", "sequence"\)/);
  assert.match(sql, /"CollaborationTurn"\("conversationId", "initiatedById", "requestId"\)/);
  assert.match(
    sql,
    /"Conversation"\("organizationId", "pullRequestId", "createdById", "requestId"\)/,
  );
  assert.match(sql, /length\("content"\) BETWEEN 1 AND 8000/);
});
test('baseline bytes and legacy eligibility table list are unchanged', () => {
  const baseline = readFileSync(join(__dirname, '../prisma/migrations/0_baseline/migration.sql'));
  assert.equal(
    createHash('sha256').update(baseline).digest('hex'),
    'e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab',
  );
  for (const name of ['Conversation', 'CollaborationTurn', 'ConversationMessage'])
    assert.ok(!EXPECTED_TABLES.includes(name));
});
