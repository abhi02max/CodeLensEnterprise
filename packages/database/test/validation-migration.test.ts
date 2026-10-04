import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('paired validation is additive, immutable, scoped, bounded and separate from test outcome', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261004000000_validation_runs/migration.sql'),
    'utf8',
  );
  for (const name of ['ValidationRun', 'ValidationAttempt', 'ValidationStep'])
    assert.ok(sql.includes(`CREATE TABLE "${name}"`));
  for (const invariant of [
    'one_active_validation',
    'Validation identity is immutable',
    'Terminal validation is immutable',
    'Validation observations are immutable',
    'Validation attempt identity is immutable',
    'Late or foreign validation observation',
    'Validation application binding rejected',
    "interval '12 minutes'",
    '"generation"=1',
    "'ORIGINAL','PATCHED'",
    '60000',
    '4096',
  ])
    assert.ok(sql.includes(invariant));
  assert.match(sql, /FOREIGN KEY \("applicationId","organizationId"\)/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /UPDATE "(?:PatchApplication|PatchProposal|CollaborationTurn)"/);
  assert.doesNotMatch(sql, /"(?:source|content|patch|command|environment)"\s+(?:TEXT|JSON)/i);
});
