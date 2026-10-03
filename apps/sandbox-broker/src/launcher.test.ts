import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { snapshotDigest } from '../../../packages/github/src/exact-git-snapshot';
import {
  canonicalPatch,
  constructPatchFile,
  materializeCandidate,
  patchHash,
  encodeFrame,
} from '@codelens/patch-core';
import { FixedPolicyLauncher } from './launcher';
import { DockerTransport } from './docker';

function fixture() {
  const content = 'old\n',
    revision = 'a'.repeat(40);
  const blobSha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
  const snapshot = {
    version: 1 as const,
    repository: 'safe/repo',
    revision,
    files: [
      {
        path: 'a.ts',
        blobSha,
        content,
        contentHash: patchHash(content),
        byteLength: Buffer.byteLength(content),
      },
    ],
  };
  const intent = {
    summary: 'Review change',
    rationale: 'Observed evidence',
    limitations: 'Not tested',
    files: [
      {
        operation: 'MODIFY' as const,
        path: 'a.ts',
        expectedBlobSha: blobSha,
        edits: [{ startLine: 1, endLine: 1, expectedText: 'old', replacement: 'new' }],
        evidenceIds: ['e1'],
      },
    ],
  };
  const pins = { headSha: revision, baseSha: 'b'.repeat(40) };
  const digest = canonicalPatch(pins, intent, [
    constructPatchFile(intent.files[0]!, {
      revision,
      path: 'a.ts',
      objectSha: blobSha,
      mode: '100644',
      kind: 'REGULAR_FILE',
      components: [],
      modificationEligible: true,
      content,
      contentHash: snapshot.files[0]!.contentHash,
    }),
  ]).digest;
  return {
    version: 1 as const,
    snapshot: { ...snapshot, digest: snapshotDigest(snapshot) },
    proposal: { ...pins, digest, intent },
  };
}
class FakeDocker extends DockerTransport {
  config: any;
  name = '';
  container = false;
  removeFails = false;
  createFails = false;
  foreign = false;
  starts = 0;
  gate?: Promise<void>;
  override async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (method === 'POST' && path.startsWith('/containers/create')) {
      if (this.createFails) throw new Error('DAEMON_UNAVAILABLE');
      this.name = path.split('=')[1]!;
      this.config = body;
      await this.gate;
      this.container = true;
      return { Id: 'd'.repeat(64) };
    }
    if (method === 'POST' && path.includes('/wait')) return { StatusCode: 0 };
    if (method === 'POST') {
      this.starts++;
      return {};
    }
    if (method === 'DELETE') {
      if (this.removeFails) throw new Error('TEST_REMOVE_FAILED');
      this.container = false;
      return {};
    }
    if (!this.container) return null;
    return {
      Id: 'd'.repeat(64),
      Name: '/' + this.name,
      Config: { Image: this.config.Image, Labels: this.foreign ? {} : this.config.Labels },
      State: { Running: false, ExitCode: 0 },
    };
  }
  override async attach() {
    const body = encodeFrame(
      { version: 1, status: 'MATERIALIZED', result: materializeCandidate(fixture()).result },
      65536,
    );
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(body.length, 4);
    return new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        this.push(Buffer.concat([header, body]));
        this.push(null);
        callback();
      },
    });
  }
}
async function setup() {
  const journal = await mkdtemp(join(tmpdir(), 'launcher-test-'));
  const docker = new FakeDocker();
  const profile = await readFile('../../infra/sandbox/seccomp.json', 'utf8');
  const launcher = new FixedPolicyLauncher(
    docker,
    'sha256:' + 'e'.repeat(64),
    profile,
    Buffer.alloc(32, 7),
    journal,
  );
  await launcher.reconcile();
  return { journal, docker, launcher };
}
it('launches fixed policy, checks output and removes its owned workspace/container', async () => {
  const { journal, docker, launcher } = await setup();
  try {
    expect(await launcher.materialize(fixture())).toMatchObject({ status: 'MATERIALIZED' });
    expect(docker.config.HostConfig.NetworkMode).toBe('none');
    expect(docker.starts).toBe(1);
    expect(docker.container).toBe(false);
    expect(await readdir(journal)).toEqual([]);
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
it('retains an unacknowledged create reservation instead of treating immediate absence as cleanup proof', async () => {
  const { journal, docker, launcher } = await setup();
  docker.createFails = true;
  try {
    await expect(launcher.materialize(fixture())).rejects.toThrow('CLEANUP_UNCERTAIN');
    expect(await readdir(journal)).toHaveLength(1);
    await expect(launcher.reconcile()).rejects.toThrow('CLEANUP_UNCERTAIN');
    await expect(launcher.materialize(fixture())).rejects.toThrow('BUSY_OR_CLEANUP_UNCERTAIN');
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
it('reserves cleanup time and refuses a launch with insufficient remaining operation budget', async () => {
  const { journal, docker, launcher } = await setup();
  try {
    await expect(launcher.materialize(fixture(), undefined, 50000)).rejects.toThrow('DEADLINE');
    expect(docker.config).toBeUndefined();
    expect(await readdir(journal)).toEqual([]);
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
it('rejects concurrent launches and fences a late create after cancellation', async () => {
  const { journal, docker, launcher } = await setup();
  let settle!: () => void;
  docker.gate = new Promise((resolve) => {
    settle = resolve;
  });
  const abort = new AbortController();
  try {
    const first = launcher.materialize(fixture(), abort.signal);
    const rejected = expect(first).rejects.toThrow('DEADLINE');
    await expect(launcher.materialize(fixture())).rejects.toThrow('BUSY');
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    settle();
    await rejected;
    expect(docker.starts).toBe(0);
    expect(docker.container).toBe(false);
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
it.each(['remove', 'foreign'])(
  'fails closed on %s cleanup, retains ownership record and blocks another launch',
  async (mode) => {
    const { journal, docker, launcher } = await setup();
    docker.removeFails = mode === 'remove';
    docker.foreign = mode === 'foreign';
    try {
      await expect(launcher.materialize(fixture())).rejects.toThrow('CLEANUP_UNCERTAIN');
      expect(docker.container).toBe(true);
      expect(await readdir(journal)).toHaveLength(1);
      await expect(launcher.materialize(fixture())).rejects.toThrow('BUSY_OR_CLEANUP_UNCERTAIN');
    } finally {
      await rm(journal, { recursive: true, force: true });
    }
  },
);
