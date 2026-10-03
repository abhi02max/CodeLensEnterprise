import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { executorPolicy } from './policy';
import {
  BrokerAuthenticator,
  signBrokerRequest,
  signBrokerResponse,
  verifyBrokerResponse,
  safeBrokerFailure,
} from './protocol';
const fixture = () => ({
  version: 1,
  snapshot: {
    version: 1,
    repository: 'safe/repo',
    revision: 'a'.repeat(40),
    digest: 'b'.repeat(64),
    files: [],
  },
  proposal: {
    headSha: 'a'.repeat(40),
    baseSha: 'c'.repeat(40),
    digest: 'd'.repeat(64),
    intent: {
      summary: 'Proposed change',
      rationale: 'Evidence',
      limitations: 'Not tested',
      files: [
        {
          operation: 'MODIFY',
          path: 'a.ts',
          expectedBlobSha: 'a'.repeat(40),
          evidenceIds: ['e1'],
          edits: [{ startLine: 1, endLine: 1, expectedText: 'old', replacement: 'new' }],
        },
      ],
    },
  },
});

it('hardcodes a restrictive policy with no request-controlled Docker options', () => {
  const profile = readFileSync('../../infra/sandbox/seccomp.json', 'utf8');
  const policy = executorPolicy('sha256:' + 'a'.repeat(64), profile, {});
  expect(policy.User).toBe('65532:65532');
  expect(policy.Cmd).toEqual([]);
  expect(policy.Env).toEqual([
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    'TZ=UTC',
    'PATH=',
    'SSL_CERT_FILE=',
  ]);
  expect(policy.HostConfig).toMatchObject({
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    Privileged: false,
    Binds: [],
    Mounts: [],
    Devices: [],
    PortBindings: {},
    Memory: 536870912,
    MemorySwap: 536870912,
    PidsLimit: 64,
    NanoCpus: 500000000,
    LogConfig: { Type: 'none' },
  });
  expect(policy.HostConfig.Tmpfs['/workspace']).toContain('noexec,nosuid,nodev');
  expect(() => executorPolicy('mutable:tag', profile, {})).toThrow();
  expect(() =>
    executorPolicy(
      'sha256:' + 'a'.repeat(64),
      '{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[]}',
      {},
    ),
  ).toThrow();
});
it('authenticates, rejects mutation, expiry and consumed nonce', () => {
  const key = Buffer.alloc(32, 7),
    auth = new BrokerAuthenticator(key);
  const request = signBrokerRequest(key, randomUUID(), 100000, fixture());
  expect(auth.consume(request, 100000)).toEqual(request.payload);
  expect(() => auth.consume(request, 100000)).toThrow('REPLAY');
  expect(() =>
    new BrokerAuthenticator(key).consume({ ...request, mac: '0'.repeat(64) }, 100000),
  ).toThrow('AUTHENTICATION');
  expect(() => new BrokerAuthenticator(key).consume(request, 200000)).toThrow('AUTHENTICATION');
  expect(() =>
    new BrokerAuthenticator(key).consume({ ...request, command: ['sh'] }, 100000),
  ).toThrow();
});
it('authenticates a typed bounded result and rejects source leakage or response substitution', () => {
  const key = Buffer.alloc(32, 7),
    nonce = randomUUID();
  const result = { version: 1, status: 'FAILED', code: 'BROKER_DEADLINE' };
  const signed = signBrokerResponse(key, nonce, result);
  expect(verifyBrokerResponse(key, nonce, signed)).toEqual(result);
  expect(() => verifyBrokerResponse(key, randomUUID(), signed)).toThrow('AUTHENTICATION');
  expect(() =>
    signBrokerResponse(key, nonce, { ...result, source: 'opaque repository text' }),
  ).toThrow();
  expect(safeBrokerFailure(new Error('opaque repository text'))).toBe('BROKER_INTERNAL_ERROR');
});
it('does not allow an authenticated caller to increase the server deadline', () => {
  expect(() =>
    signBrokerRequest(Buffer.alloc(32, 7), randomUUID(), 100000, fixture(), 250001),
  ).toThrow('DEADLINE');
});
