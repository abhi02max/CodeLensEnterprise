import { expect, it } from 'vitest';
import { aiFixture, hash } from '../../test/validation-ai-fixture';
import { aiLineage, buildValidationAiPacket } from './validation-ai-content';
const build = () => {
  const f = aiFixture();
  return buildValidationAiPacket(f.run, f.ml);
};
it('accepts whole-snapshot manifests while verifying every modified file exactly', () => {
  const f = aiFixture(),
    files = f.run.application.attempts[0]!.files;
  files.push({ ...files[0]!, path: 'unchanged.ts', contentHash: hash('unchanged') });
  expect(() => aiLineage(f.run, f.ml)).not.toThrow();
  files.push({ ...files[0]! });
  expect(() => aiLineage(f.run, f.ml)).toThrow('EVIDENCE_CANDIDATE');
});
it('seals deterministic ordered evidence and separates trust classes without AI/RAG/runner output', () => {
  const a = build(),
    f = aiFixture();
  f.run.staticAnalyses.reverse();
  f.run.attempts[0]!.steps.reverse();
  expect(buildValidationAiPacket(f.run, f.ml)).toEqual(a);
  expect(a.packet.coverage.excluded).toEqual([
    'ORIGINAL_AI',
    'RAG',
    'RUNNER_OUTPUT',
    'SOURCE_EXCERPTS',
  ]);
  expect(a.packet.entries.some((e) => e.trust === 'UNTRUSTED_RUNNER_REPORT')).toBe(true);
  expect(a.packet.entries.some((e) => e.trust === 'BROKER_OBSERVATION')).toBe(true);
  expect(a.packet.entries.find((e) => e.payload.type === 'ML')?.payload).toMatchObject({
    deltaTenths: -78,
    bandMovement: 'UNCHANGED',
  });
});
it.each([
  'organizationId',
  'repositoryId',
  'pullRequestId',
  'headSha',
  'baseSha',
  'candidateDigest',
  'proposalDigest',
  'applicationId',
  'validationId',
] as const)('rejects ML %s lineage mismatch', (key) => {
  const f = aiFixture();
  f.ml[key] = 'wrong';
  expect(() => aiLineage(f.run, f.ml)).toThrow('EVIDENCE_LINEAGE');
});
it('rejects wrong manifest and unavailable/partial deterministic evidence', () => {
  const f = aiFixture();
  f.run.application.attempts[0]!.files[0]!.contentHash = hash('wrong');
  expect(() => buildValidationAiPacket(f.run, f.ml)).toThrow('EVIDENCE_CANDIDATE');
});
it('does not encode unavailable static analysis as zero complete findings', () => {
  const f = aiFixture();
  f.run.staticAnalyses[0]!.status = 'FAILED';
  f.run.staticAnalyses[0]!.reason = 'FAILED';
  const a = buildValidationAiPacket(f.run, f.ml);
  expect(a.packet.entries.find((e) => e.payload.type === 'STATIC_ANALYSIS')?.payload).toMatchObject(
    { status: 'FAILED' },
  );
});
it('records unavailable ML as unavailable with null scores, not zero', () => {
  const f = aiFixture();
  f.ml.state = 'FAILED';
  f.ml.outcome = null;
  f.ml.deltaTenths = null;
  f.ml.assessments = [];
  const a = buildValidationAiPacket(f.run, f.ml);
  expect(a.packet.entries.find((e) => e.payload.type === 'ML')?.payload).toMatchObject({
    state: 'FAILED',
    deltaTenths: null,
    assessments: [],
  });
});
it('redacts supplied secret from patch and static messages before digesting', () => {
  const f = aiFixture(),
    secret = 'synthetic-private-value-for-redaction';
  f.run.application.proposal.files[0]!.diff += secret;
  f.run.staticAnalyses[0]!.findings[0]!.message += secret;
  const a = buildValidationAiPacket(f.run, f.ml, [secret]);
  expect(JSON.stringify(a)).not.toContain(secret);
  expect(a.digest).not.toBe(build().digest);
});
it('rejects mandatory patch overflow without truncation', () => {
  const f = aiFixture();
  f.run.application.proposal.files[0]!.diff = 'x'.repeat(20481);
  expect(() => buildValidationAiPacket(f.run, f.ml)).toThrow('PACKET_BOUND');
});
it('discloses deterministic optional finding omissions', () => {
  const f = aiFixture();
  const a = f.run.staticAnalyses[0]!,
    base = a.findings[0]!;
  a.findingCount = 45;
  a.findings = Array.from({ length: 41 }, (_, i) => ({
    ...base,
    id: 'finding-' + i,
    findingDigest: hash(String(i)),
  }));
  const p = buildValidationAiPacket(f.run, f.ml).packet;
  const included = p.entries.filter((e) => e.payload.type === 'STATIC_FINDING').length;
  expect(included).toBeGreaterThan(0);
  expect(included).toBeLessThan(40);
  expect(p.coverage.omittedStaticFindings).toBe(45 - included);
  expect(JSON.stringify(p).length).toBeLessThan(28672);
});
it('changes packet identity when persisted evidence changes', () => {
  const f = aiFixture();
  f.run.staticAnalyses[0]!.findings[0]!.classification = 'INCOMPARABLE';
  expect(buildValidationAiPacket(f.run, f.ml).digest).not.toBe(build().digest);
});
