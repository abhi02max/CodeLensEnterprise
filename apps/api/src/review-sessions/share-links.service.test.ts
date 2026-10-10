import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { CreateShareLinkSchema, Role, ShareScope } from '@codelens/shared';
import { IS_PUBLIC_KEY, REQUIRED_ROLE_KEY } from '../common/decorators';
import { ShareLinksService, shareUrlFor } from './share-links.service';
import { ReviewSessionsService } from './review-sessions.service';
import { ReviewSessionsController } from './review-sessions.controller';

function fixture() {
  const token = 'deterministic-unit-fixture';
  const row = {
    id: 'link',
    organizationId: 'org',
    pullRequestId: 'pr',
    scope: ShareScope.FULL,
    redactCode: true,
    tokenHash: 'fixture-hash',
    passphraseHash: null as string | null,
    expiresAt: new Date('2099-01-01'),
    revokedAt: null as Date | null,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: new Date('2026-10-08'),
    createdBy: { id: 'admin', name: 'Admin' },
  };
  const db = {
    pullRequest: {
      findFirst: vi.fn(async () => ({
        id: 'pr',
        number: 1,
        repository: { fullName: 'fixture/repo', private: false },
      })),
    },
    shareLink: {
      create: vi.fn(async ({ data }) => ({ ...row, ...data })),
      findMany: vi.fn(async () => [row]),
      findUnique: vi.fn(async () => row),
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }) => ({ ...row, ...data })),
    },
  };
  const crypto = {
    generateToken: vi.fn(() => ({ token, hash: row.tokenHash })),
    hashToken: vi.fn(() => row.tokenHash),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new ShareLinksService(
    { unscoped: db } as never,
    { webUrl: 'https://review.example.test:8443/' } as never,
    crypto as never,
    audit as never,
  );
  const params = {
    organizationId: 'org',
    pullRequestId: 'pr',
    userId: 'admin',
    input: CreateShareLinkSchema.parse({ scope: 'FULL', redactCode: true, expiresInHours: 24 }),
    traceId: 'trace',
    ipAddress: null,
    userAgent: null,
  };
  return { token, row, db, crypto, audit, service, params };
}

describe('canonical shared reader URL', () => {
  it.each(['https://review.example.test', 'https://review.example.test/'])(
    'uses configured base %s',
    (base) => {
      expect(shareUrlFor(base, 'fixture-token')).toBe(
        'https://review.example.test/shared/fixture-token',
      );
    },
  );
  it('preserves the configured port and base path', () => {
    expect(shareUrlFor('https://review.example.test:8443/codelens/', 'fixture-token')).toBe(
      'https://review.example.test:8443/codelens/shared/fixture-token',
    );
  });
  it('returns the canonical URL once while persisting only the existing token hash', async () => {
    const f = fixture();
    const before = Date.now();
    const result = await f.service.create(f.params);
    expect(result.url).toBe(`https://review.example.test:8443/shared/${f.token}`);
    expect(result.token).toBe(f.token);
    expect(f.crypto.generateToken).toHaveBeenCalledWith(32);
    const stored = f.db.shareLink.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({
      organizationId: 'org',
      pullRequestId: 'pr',
      tokenHash: 'fixture-hash',
      scope: ShareScope.FULL,
      redactCode: true,
      passphraseHash: null,
    });
    expect(stored).not.toHaveProperty('token');
    expect(stored).not.toHaveProperty('url');
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 3600000);
    expect(JSON.stringify(f.audit.record.mock.calls)).not.toContain(f.token);
  });
  it('retains SUMMARY scope without promoting visibility', async () => {
    const f = fixture();
    f.params.input.scope = ShareScope.SUMMARY;
    expect((await f.service.create(f.params)).scope).toBe(ShareScope.SUMMARY);
  });
  it('lists metadata without recovering token or URL', async () => {
    const f = fixture();
    const [link] = await f.service.list('org', 'pr');
    expect(link.url).toBe('');
    expect(link).not.toHaveProperty('token');
    expect(f.db.shareLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pullRequestId: 'pr', organizationId: 'org' },
      }),
    );
  });
  it('rejects foreign PR creation before token generation', async () => {
    const f = fixture();
    f.db.pullRequest.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.service.create(f.params)).rejects.toThrow();
    expect(f.crypto.generateToken).not.toHaveBeenCalled();
    expect(f.db.shareLink.create).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'expired', 'revoked'])(
    'preserves fail-closed %s token resolution',
    async (state) => {
      const f = fixture();
      if (state === 'unknown') f.db.shareLink.findUnique.mockResolvedValueOnce(null as never);
      if (state === 'expired') f.row.expiresAt = new Date(0);
      if (state === 'revoked') f.row.revokedAt = new Date();
      await expect(f.service.resolve(f.token, null)).rejects.toThrow();
      expect(f.crypto.hashToken).toHaveBeenCalledWith(f.token);
      expect(f.db.shareLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: 'fixture-hash' },
        }),
      );
    },
  );
  it('preserves the existing passphrase check, without putting it in the URL', async () => {
    const f = fixture();
    const hash = vi.spyOn(bcrypt, 'hash').mockResolvedValue('fixture-passphrase-hash' as never);
    const compare = vi.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
    try {
      const result = await f.service.create({
        ...f.params,
        input: { ...f.params.input, passphrase: 'unit-only-passphrase' },
      });
      expect(result.hasPassphrase).toBe(true);
      expect(result.url).not.toContain('passphrase');
      expect(hash).toHaveBeenCalledWith('unit-only-passphrase', expect.any(Number));
      f.row.passphraseHash = 'fixture-passphrase-hash';
      await expect(f.service.resolve(f.token, null)).rejects.toThrow();
      await expect(f.service.resolve(f.token, 'wrong')).rejects.toThrow();
      compare.mockResolvedValueOnce(true as never);
      expect(await f.service.resolve(f.token, 'unit-only-passphrase')).toMatchObject({
        organizationId: 'org',
        pullRequestId: 'pr',
        scope: ShareScope.FULL,
        redactCode: true,
      });
    } finally {
      hash.mockRestore();
      compare.mockRestore();
    }
  });
  it('retains scoped revocation and never returns a raw token', async () => {
    const f = fixture();
    const link = await f.service.revoke({ ...f.params, shareLinkId: 'link' });
    expect(f.db.shareLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'link', pullRequestId: 'pr', organizationId: 'org' },
      }),
    );
    expect(link.revokedAt).not.toBeNull();
    expect(link.url).toBe('');
    expect(link).not.toHaveProperty('token');
  });
});

describe('existing shared payload projection', () => {
  it('keeps share management ADMIN-only and only the existing shared reader public', () => {
    for (const method of ['createShareLink', 'listShareLinks', 'revokeShareLink'] as const) {
      const handler = ReviewSessionsController.prototype[method];
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler)).toBe(Role.ADMIN);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ReviewSessionsController.prototype.shared)).toBe(
      true,
    );
  });
  it.each([ShareScope.SUMMARY, ShareScope.FULL])('does not broaden %s exposure', async (scope) => {
    const db = {
      pullRequest: {
        findFirst: vi.fn(async () => ({
          id: 'pr',
          repository: { fullName: 'fixture/repo' },
          headSha: 'a'.repeat(40),
        })),
      },
      review: { findMany: vi.fn(async () => []) },
    };
    const service = new ReviewSessionsService(
      { unscoped: db } as never,
      {} as never,
      { getPolicy: vi.fn(async () => ({ blockingSeverity: 'HIGH' })) } as never,
      {
        getLatest: vi.fn(async () => ({
          analyzed: true,
          run: null,
          risk: null,
          aiReview: null,
          findings: [{ severity: 'HIGH', snippet: 'private-source', message: 'Recorded finding' }],
          metrics: null,
          ragContext: [],
          degradation: [],
        })),
      } as never,
      {} as never,
      {} as never,
    );
    const view = await service.getSharedSession({
      organizationId: 'org',
      pullRequestId: 'pr',
      scope,
      redactCode: true,
      expiresAt: new Date('2099-01-01'),
    });
    expect(view.scope).toBe(scope);
    expect(view.findings).toHaveLength(scope === ShareScope.FULL ? 1 : 0);
    expect(JSON.stringify(view)).not.toContain('private-source');
    for (const field of [
      'permissions',
      'shareLinks',
      'comments',
      'toolRuns',
      'audit',
      'conversations',
      'proposals',
    ])
      expect(view).not.toHaveProperty(field);
    expect(db.pullRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pr', organizationId: 'org' } }),
    );
  });
});
