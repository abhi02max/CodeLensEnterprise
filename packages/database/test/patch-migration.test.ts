import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('patch migration adds normalized immutable data without rewriting existing rows', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/20261003020000_patch_proposals/migration.sql'),
    'utf8',
  );
  for (const table of ['PatchProposal', 'PatchProposalFile', 'PatchProposalEvidence'])
    assert.ok(sql.includes(`CREATE TABLE "${table}"`));
  assert.match(sql, /modification|modify_only/);
  assert.match(sql, /protect_proposal_file/);
  assert.match(sql, /protect_proposal_evidence/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /UPDATE "(?:CollaborationTurn|Conversation|EvidenceReference)"/);
});
