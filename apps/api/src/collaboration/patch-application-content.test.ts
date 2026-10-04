import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalPatch, constructPatchFile, patchHash } from '@codelens/patch-core';
import { snapshotDigest } from '@codelens/github/dist/exact-git-snapshot';
import { reconstructApplication, verifyApplicationManifest } from './patch-application-content';
import { PatchApplicationRequestSchema } from '@codelens/shared';
import { PatchApplicationJobSchema } from '../queues/patch-application.queue';

export function applicationFixture() {
  const content = 'one\ntwo\nthree\n',
    bytes = Buffer.from(content);
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const headSha = 'a'.repeat(40),
    baseSha = 'b'.repeat(40);
  const source = {
    revision: headSha,
    path: 'a.ts',
    kind: 'REGULAR_FILE' as const,
    mode: '100644',
    objectSha: blobSha,
    content,
    contentHash: patchHash(content),
    components: [],
    modificationEligible: true,
  };
  const intent = {
    summary: 'Proposed change',
    rationale: 'Evidence linked',
    limitations: 'Not validated',
    files: [
      {
        operation: 'MODIFY' as const,
        path: 'a.ts',
        expectedBlobSha: blobSha,
        edits: [{ startLine: 2, endLine: 2, expectedText: 'two', replacement: 'new' }],
        evidenceIds: ['e1'],
      },
    ],
  };
  const file = constructPatchFile(intent.files[0]!, source);
  const canonical = canonicalPatch({ headSha, baseSha }, intent, [file]);
  const tree = {
    version: 1 as const,
    repository: 'owner/repo',
    revision: headSha,
    files: [
      {
        path: source.path,
        blobSha,
        content,
        contentHash: source.contentHash,
        byteLength: bytes.length,
      },
    ],
  };
  const snapshot = { ...tree, digest: snapshotDigest(tree) };
  const proposal = { headSha, baseSha, digest: canonical.digest, ...intent, files: [file] };
  return { snapshot, proposal, intent, source };
}
describe('canonical application reconstruction', () => {
  it('derives reproducible candidate hashes from exact pinned bytes without modifying source', () => {
    const f = applicationFixture(),
      before = JSON.stringify(f);
    const first = reconstructApplication(f.snapshot, f.proposal);
    expect(first).toEqual(reconstructApplication(f.snapshot, f.proposal));
    expect(first.expected.files[0]?.contentHash).toBe(patchHash('one\nnew\nthree\n'));
    expect(JSON.stringify(f)).toBe(before);
    expect(JSON.stringify(first.expected)).not.toContain('one\\n');
  });
  it.each(['headSha', 'baseSha', 'digest'] as const)('rejects altered %s', (key) => {
    const f = applicationFixture();
    f.proposal[key] = 'c'.repeat(key === 'digest' ? 64 : 40);
    expect(() => reconstructApplication(f.snapshot, f.proposal)).toThrow();
  });
  it.each(['oldBlobSha', 'oldContentHash', 'newContentHash'] as const)(
    'rejects altered file %s',
    (key) => {
      const f = applicationFixture();
      f.proposal.files[0]![key] = 'c'.repeat(key === 'oldBlobSha' ? 40 : 64);
      expect(() => reconstructApplication(f.snapshot, f.proposal)).toThrow();
    },
  );
  it('rejects wrong source bytes, digest, range and expected text', () => {
    const f = applicationFixture();
    f.snapshot.files[0]!.content = 'other';
    expect(() => reconstructApplication(f.snapshot, f.proposal)).toThrow();
    const g = applicationFixture();
    g.proposal.files[0]!.edits[0]!.endLine = 50;
    expect(() => reconstructApplication(g.snapshot, g.proposal)).toThrow();
    const h = applicationFixture();
    h.proposal.files[0]!.edits[0]!.expectedText = 'wrong';
    expect(() => reconstructApplication(h.snapshot, h.proposal)).toThrow();
  });
  it.each(['snapshotDigest', 'proposalDigest', 'digest'] as const)(
    'rejects manifest %s mismatch',
    (key) => {
      const f = applicationFixture(),
        expected = reconstructApplication(f.snapshot, f.proposal).expected;
      expect(() =>
        verifyApplicationManifest(expected, { ...expected, [key]: 'c'.repeat(64) }),
      ).toThrow();
    },
  );
  it('rejects omitted, duplicate, unexpected paths and wrong result hash/length', () => {
    const f = applicationFixture(),
      expected = reconstructApplication(f.snapshot, f.proposal).expected;
    for (const files of [
      [],
      [...expected.files, ...expected.files],
      [{ ...expected.files[0]!, path: 'other.ts' }],
      [{ ...expected.files[0]!, contentHash: 'c'.repeat(64) }],
      [{ ...expected.files[0]!, byteLength: 999 }],
    ])
      expect(() => verifyApplicationManifest(expected, { ...expected, files })).toThrow();
    expect(() => verifyApplicationManifest(expected, { ...expected, source: 'secret' })).toThrow();
    expect(verifyApplicationManifest(expected, expected)).toEqual(expected);
  });
  it.each([
    'command',
    'environment',
    'image',
    'mounts',
    'network',
    'source',
    'patch',
    'organizationId',
    'repositoryId',
  ])('rejects API %s authority injection', (field) => {
    expect(
      PatchApplicationRequestSchema.safeParse({
        requestId: '12345678-1234-4234-8234-123456789012',
        expectedProposalRevision: 1,
        expectedProposalDigest: 'a'.repeat(64),
        [field]: 'untrusted',
      }).success,
    ).toBe(false);
  });
  it('rejects source or credentials in an identifiers-only queue payload', () => {
    expect(
      PatchApplicationJobSchema.safeParse({
        applicationId: 'a',
        attemptId: 'b',
        organizationId: 'org',
        token: 'secret',
      }).success,
    ).toBe(false);
  });
});
