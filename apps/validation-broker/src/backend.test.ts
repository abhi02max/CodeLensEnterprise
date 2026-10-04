import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DockerValidationBackend } from './docker-backend';
import { approvedProfile } from './profile';
import type { Daemon } from './docker';
const input = {
  version: 1 as const,
  profile: 'vitest-unit-v1' as const,
  files: [{ path: 'package.json', content: '{}' }],
};
const profile = approvedProfile(
  'vitest-unit-v1',
  'sha256:' + 'a'.repeat(64),
  'b'.repeat(64),
  'c'.repeat(64),
);
describe.skipIf(process.platform === 'win32')('ownership and uncertain cleanup fencing', () => {
  it('lost create acknowledgment cannot become disposal proof or permit another execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'validation-backend-'));
    let volume: any;
    const daemon: Daemon = {
      call: vi.fn(async (method, path, body: any) => {
        if (method === 'POST' && path === '/volumes/create') {
          volume = body;
          return body;
        }
        if (path.startsWith('/containers/')) {
          if (method === 'POST') throw new Error('lost ack');
          return null;
        }
        if (method === 'GET' && path.startsWith('/volumes/')) return volume;
        if (method === 'DELETE') {
          volume = null;
          return {};
        }
        throw new Error('unexpected operation');
      }),
      attach: vi.fn(),
    };
    try {
      const backend = new DockerValidationBackend(
        daemon,
        '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}',
        randomBytes(32),
        'codelens_validation_test',
        root,
      );
      await backend.reconcile();
      const result = await backend.execute(
        input,
        profile,
        randomUUID(),
        Date.now() + 120000,
        new AbortController().signal,
      );
      expect(result.status).toBe('INFRASTRUCTURE_FAILED');
      expect(result.observed.cleanup).toBe('UNCERTAIN');
      expect(await readdir(root)).toHaveLength(1);
      await expect(
        backend.execute(
          input,
          profile,
          randomUUID(),
          Date.now() + 120000,
          new AbortController().signal,
        ),
      ).rejects.toThrow('BUSY_OR_CLEANUP_UNCERTAIN');
      expect(daemon.attach).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('a foreign same-name volume is never mounted or deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'validation-backend-'));
    let volume: any;
    const calls: string[] = [];
    const daemon: Daemon = {
      call: vi.fn(async (method, path, body: any) => {
        calls.push(method + ' ' + path);
        if (method === 'POST' && path === '/volumes/create') {
          volume = { ...body, Labels: {} };
          return volume;
        }
        if (method === 'GET' && path.startsWith('/volumes/')) return volume;
        throw new Error('forbidden daemon operation');
      }),
      attach: vi.fn(),
    };
    try {
      const backend = new DockerValidationBackend(
        daemon,
        '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}',
        randomBytes(32),
        'codelens_validation_test',
        root,
      );
      await backend.reconcile();
      const result = await backend.execute(
        input,
        profile,
        randomUUID(),
        Date.now() + 120000,
        new AbortController().signal,
      );
      expect(result.observed.cleanup).toBe('UNCERTAIN');
      expect(calls.some((call) => call.startsWith('DELETE') || call.includes('/containers/'))).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
