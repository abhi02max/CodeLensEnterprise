import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('static observations add source-free immutable scoped tables without altering prior history', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261004010000_validation_static_findings/migration.sql'),
    'utf8',
  );
  for (const name of ['ValidationStaticAnalysis', 'ValidationFinding'])
    assert.ok(sql.includes(`CREATE TABLE "${name}"`));
  for (const invariant of [
    'Static validation history is immutable',
    'Static validation binding rejected',
    'Late or foreign static finding rejected',
    '"findingCount" BETWEEN 0 AND 500',
    '"attemptId","validationId","organizationId"',
    'rulesetDigest',
    'configurationDigest',
    'fingerprintVersion',
    'UNCHANGED',
    'RESOLVED',
    'INTRODUCED',
    'CHANGED',
    'INCOMPARABLE',
  ])
    assert.ok(sql.includes(invariant));
  assert.doesNotMatch(
    sql,
    /\b(?:DROP|TRUNCATE|ALTER|UPDATE)\s+(?:TABLE|"ValidationRun"|"ReviewRun"|"PatchApplication")/i,
  );
  assert.doesNotMatch(sql, /"(?:source|snippet|content|command|environment)"\s+(?:TEXT|JSON)/i);
});
