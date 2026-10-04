import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { approvedProfile, containerPolicy, ENVIRONMENT } from './profile';
import { authenticate, signRequest, signResult, verifyResult } from './protocol';
import { runnerReported, sanitizeOutput } from './output';
const key = randomBytes(32),
  input = {
    version: 1,
    profile: 'vitest-unit-v1',
    files: [{ path: 'package.json', content: '{}' }],
  };
describe('validation authentication', () => {
  it('authenticates exact protocol and rejects tamper, expiry, other keys and scope injection', () => {
    const req = signRequest(key, randomUUID(), input);
    expect(authenticate(key, req).input.profile).toBe('vitest-unit-v1');
    for (const raw of [
      { ...req, protocol: 'codelens-materialization-v1' },
      { ...req, command: 'sh' },
      { ...req, input: { ...req.input, profile: 'typescript-typecheck-v1' } },
    ])
      expect(() => authenticate(key, raw)).toThrow();
    expect(() => authenticate(randomBytes(32), req)).toThrow();
    expect(() => authenticate(key, req, req.issuedAt + 60001)).toThrow();
    expect(() => signRequest(Buffer.alloc(0), randomUUID(), input)).toThrow();
  });
  it('never accepts request-owned image/resource/command/environment', () => {
    for (const field of [
      'image',
      'command',
      'environment',
      'mount',
      'registry',
      'timeout',
      'network',
    ])
      expect(() => signRequest(key, randomUUID(), { ...input, [field]: 'evil' })).toThrow();
  });
});
describe('fixed launch profile', () => {
  it('requires immutable identities and prevents backend configuration by input', () => {
    expect(() =>
      approvedProfile('vitest-unit-v1', 'node:latest', 'a'.repeat(64), 'b'.repeat(64)),
    ).toThrow();
    const profile = approvedProfile(
      'vitest-unit-v1',
      'sha256:' + 'c'.repeat(64),
      'a'.repeat(64),
      'b'.repeat(64),
    );
    const p = containerPolicy(
      profile,
      JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }),
      {},
      'owned',
    );
    expect(p.User).toBe('65532:65532');
    expect(p.Env).toEqual(ENVIRONMENT);
    expect(p.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      Devices: [],
      Binds: [],
      PidsLimit: 64,
      MemorySwap: 536870912,
    });
    expect(p.HostConfig.Mounts).toEqual([
      {
        Type: 'volume',
        Source: 'owned',
        Target: '/input',
        ReadOnly: true,
        VolumeOptions: { NoCopy: true },
      },
    ]);
    expect(p.Entrypoint).toEqual(['/nodejs/bin/node', '/runner.cjs']);
    expect(p.Cmd).toEqual(['vitest-unit-v1']);
    expect(Object.isFrozen(profile)).toBe(true);
  });
});
describe('untrusted reports and terminal output', () => {
  it('cannot switch report kind or overflow byte-bounded Unicode excerpts', () => {
    const bytes = Buffer.from(
      '\x1eCODELENS_RUNNER_V1:' +
        JSON.stringify({ version: 1, kind: 'tests', passed: 1, failed: 0, total: 1 }),
    );
    expect(runnerReported(bytes, 'typecheck').status).toBe('REJECTED');
    expect(Buffer.byteLength(sanitizeOutput('漢'.repeat(20000)))).toBeLessThanOrEqual(8192);
  });
  it('keeps counts untrusted and rejects duplicate/malformed/oversized reports', () => {
    const valid =
      '\x1eCODELENS_RUNNER_V1:' +
      JSON.stringify({ version: 1, kind: 'tests', passed: 1, failed: 0, total: 1 });
    expect(runnerReported(Buffer.from(valid))).toMatchObject({ trusted: false, status: 'VALID' });
    for (const output of [
      valid + '\n' + valid,
      '\x1eCODELENS_RUNNER_V1:{}',
      '\x1eCODELENS_RUNNER_V1:' + 'x'.repeat(65536),
    ])
      expect(runnerReported(Buffer.from(output)).status).toBe('REJECTED');
    expect(runnerReported(Buffer.from('')).status).toBe('MISSING');
  });
  it('strips control/OSC/ANSI/bidi and redacts supplied secrets with bounded excerpts', () => {
    const output = sanitizeOutput(
      '\x1b]8;;https://evil\x07\x1b[31msecret-marker\x1b[0m\u202e\0' + 'a'.repeat(20000),
      ['secret-marker'],
    );
    expect(output.length).toBeLessThanOrEqual(8192);
    expect(output).not.toContain('secret-marker');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\u202e');
  });
});
