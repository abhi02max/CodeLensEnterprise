import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createServer, createConnection, type AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { snapshotDigest } from '@codelens/github';
import { canonicalPatch, constructPatchFile, normalizePatch, patchHash } from './patch';
import { materializeCandidate } from './materialization';
import { readFrame, encodeFrame } from './frame';

export function fixture() {
  const content = 'one\ntwo\nthree\n';
  const blobSha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
  const snapshot = {
    version: 1 as const,
    repository: 'safe/repo',
    revision: 'a'.repeat(40),
    files: [
      {
        path: 'src/a.ts',
        blobSha,
        content,
        contentHash: patchHash(content),
        byteLength: Buffer.byteLength(content),
      },
    ],
  };
  const intent = normalizePatch({
    summary: 'Review change',
    rationale: 'Observed evidence',
    limitations: 'Not tested',
    files: [
      {
        operation: 'MODIFY',
        path: 'src/a.ts',
        expectedBlobSha: blobSha,
        edits: [{ startLine: 2, endLine: 2, expectedText: 'two', replacement: 'new' }],
        evidenceIds: ['e1'],
      },
    ],
  });
  const source = {
    revision: snapshot.revision,
    path: 'src/a.ts',
    kind: 'REGULAR_FILE' as const,
    mode: '100644',
    objectSha: blobSha,
    components: [],
    modificationEligible: true,
    content,
    contentHash: patchHash(content),
  };
  const pins = { headSha: snapshot.revision, baseSha: 'b'.repeat(40) };
  const digest = canonicalPatch(pins, intent, [
    constructPatchFile(intent.files[0]!, source),
  ]).digest;
  return {
    version: 1 as const,
    snapshot: { ...snapshot, digest: snapshotDigest(snapshot) },
    proposal: { ...pins, digest, intent },
  };
}
it('materializes with the same Phase 3D content and digest semantics', () => {
  const request = fixture(),
    before = JSON.stringify(request);
  const result = materializeCandidate(request);
  expect(result.candidates[0]!.content).toBe('one\nnew\nthree\n');
  expect(result.result.files[0]!.contentHash).toBe(patchHash('one\nnew\nthree\n'));
  expect(materializeCandidate(request).result).toEqual(result.result);
  expect(JSON.stringify(request)).toBe(before);
});
it.each(['content', 'blobSha', 'contentHash', 'byteLength', 'digest', 'revision'])(
  'rejects forged snapshot %s',
  (field) => {
    const request = fixture();
    if (field === 'digest' || field === 'revision')
      Object.assign(request.snapshot, { [field]: '0'.repeat(field === 'digest' ? 64 : 40) });
    else
      Object.assign(request.snapshot.files[0]!, { [field]: field === 'byteLength' ? 1 : 'fake' });
    expect(() => materializeCandidate(request)).toThrow();
  },
);
it.each(['command', 'image', 'mounts', 'environment', 'network', 'capabilities', 'limits'])(
  'rejects caller authority %s',
  (field) => {
    expect(() => materializeCandidate({ ...fixture(), [field]: 'untrusted' })).toThrow();
  },
);
it.each(['.git/config', 'CON.txt', '../x', 'src/x.', 'SRC/a.ts'])(
  'rejects unsafe or conflicting source %s',
  (path) => {
    const request = fixture();
    request.snapshot.files.push({ ...request.snapshot.files[0]!, path });
    request.snapshot.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    request.snapshot.digest = snapshotDigest(request.snapshot);
    expect(() => materializeCandidate(request)).toThrow();
  },
);
it('rejects overlap, stale exact text and proposal digest mismatch', () => {
  for (const mode of ['overlap', 'text', 'digest']) {
    const request = fixture();
    if (mode === 'overlap')
      request.proposal.intent.files[0]!.edits.push(request.proposal.intent.files[0]!.edits[0]!);
    if (mode === 'text') request.proposal.intent.files[0]!.edits[0]!.expectedText = 'wrong';
    if (mode === 'digest') request.proposal.digest = '0'.repeat(64);
    expect(() => materializeCandidate(request)).toThrow();
  }
});
it('frames exactly one bounded UTF-8 message', async () => {
  const frame = encodeFrame({ ok: true }, 64);
  expect(await readFrame(Readable.from([frame.subarray(0, 2), frame.subarray(2)]), 64)).toEqual({
    ok: true,
  });
  expect(await readFrame(Readable.from([...frame].map((byte) => Buffer.from([byte]))), 64)).toEqual(
    {
      ok: true,
    },
  );
  for (const bad of [
    frame.subarray(0, 3),
    frame.subarray(0, -1),
    Buffer.concat([frame, frame]),
    Buffer.from([0, 0, 1, 0]),
    Buffer.from([0, 0, 0, 1, 255]),
    Buffer.from([0, 0, 0, 1, 123]),
  ])
    await expect(readFrame(Readable.from([bad]), 64)).rejects.toThrow();
  expect(() => encodeFrame({ large: 'x'.repeat(64) }, 64)).toThrow();
});
it('rejects an otherwise valid manifest exceeding the smaller response bound', () => {
  const request = fixture();
  const original = request.snapshot.files[0]!;
  request.snapshot.files = Array.from({ length: 1000 }, (_, n) => ({
    ...original,
    path: n.toString().padStart(4, '0') + 'a'.repeat(251),
  }));
  request.snapshot.digest = snapshotDigest(request.snapshot);
  const edit = request.proposal.intent.files[0]!;
  edit.path = request.snapshot.files[0]!.path;
  request.proposal.digest = canonicalPatch(
    { headSha: request.proposal.headSha, baseSha: request.proposal.baseSha },
    request.proposal.intent,
    [
      constructPatchFile(edit, {
        revision: request.snapshot.revision,
        path: edit.path,
        objectSha: original.blobSha,
        kind: 'REGULAR_FILE',
        mode: '100644',
        components: [],
        modificationEligible: true,
        content: original.content,
        contentHash: original.contentHash,
      }),
    ],
  ).digest;
  expect(() => materializeCandidate(request)).toThrow('Materialization preconditions failed');
});
it('preserves a half-closed data channel until the framed response is sent', async () => {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    void readFrame(socket, 64)
      .then((value) => socket.end(encodeFrame(value, 64)))
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createConnection({
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    allowHalfOpen: true,
  });
  try {
    const response = readFrame(client, 64);
    client.end(encodeFrame({ ok: true }, 64));
    expect(await response).toEqual({ ok: true });
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
