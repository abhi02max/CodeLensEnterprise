import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('ML comparison migration adds immutable scoped advisory tables only', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261005000000_validation_ml_assessments/migration.sql'),
    'utf8',
  );
  for (const required of [
    'CREATE TABLE "ValidationMlComparison"',
    'CREATE TABLE "ValidationMlAssessment"',
    'Terminal ML comparison is immutable',
    'ML assessments are immutable',
    'ML binding is immutable',
    'ML preparation cannot be repinned',
    'ML lineage binding rejected',
    'Late or foreign ML assessment rejected',
    'ML pair is incomplete',
    'ML scores cannot compare unavailable observations',
    '"comparisonId","side"',
    '"organizationId","requestedById","requestId"',
    '"scoreTenths" IS NOT NULL AND "band" IS NOT NULL',
    '"probabilityMicros" IS NOT NULL AND "confidenceMillis" IS NOT NULL',
  ])
    assert.ok(sql.includes(required), required);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|ALTER)\s+TABLE/i);
  assert.doesNotMatch(sql, /"(?:source|diff|credential|command|riskyPaths)"\s+(?:TEXT|JSON)/i);
});
