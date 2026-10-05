import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('AI re-review migration is additive and fences immutable evidence/history/budgets', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261005010000_validation_ai_rereviews/migration.sql'),
    'utf8',
  );
  for (const text of [
    'CREATE TABLE "ValidationAiReview"',
    'CREATE TABLE "ValidationAiReviewAttempt"',
    'CREATE TABLE "ValidationAiEvidenceReference"',
    'Terminal AI review is immutable',
    'Sealed AI evidence is immutable',
    'AI lineage is immutable',
    'AI preparation cannot be repinned',
    'AI attempt fence rejected',
    'AI lineage binding rejected',
    'Late AI finalization',
    'requests BETWEEN 0 AND 2',
    'retries+repairs<=1',
    'validation_ai_one_active',
  ])
    assert.ok(sql.includes(text), text);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|ALTER)\s+TABLE/i);
  assert.doesNotMatch(sql, /"(?:credential|prompt|command|source)"\s+(?:TEXT|JSON)/i);
});
