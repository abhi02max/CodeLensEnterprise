import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('application migration is additive, scoped, immutable and fail-closed', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261003030000_patch_applications/migration.sql'),
    'utf8',
  );
  for (const name of ['PatchApplication', 'PatchApplicationAttempt', 'PatchApplicationFileResult'])
    assert.ok(sql.includes(`CREATE TABLE "${name}"`));
  for (const invariant of [
    'one_active_patch_application',
    'one_active_patch_application_attempt',
    'protect_patch_application',
    'verify_patch_application_scope',
    'protect_patch_application_file_result',
    'Terminal application is immutable',
    'Execution fence cannot be replaced',
  ])
    assert.ok(sql.includes(invariant));
  assert.match(sql, /FOREIGN KEY \("proposalId","organizationId","turnId"\)/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.match(sql, /interval '150 seconds'/);
  assert.match(sql, /"generation" = 1/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(
    sql,
    /UPDATE "(?:PatchProposal|CollaborationTurn|Conversation|EvidenceReference)"/,
  );
  assert.doesNotMatch(sql, /"(?:content|source|patch|replacement|diff)"\s+(?:TEXT|JSON)/i);
});
