import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import {
  AuditAction,
  BCRYPT_ROUNDS,
  ShareScope,
  type CreateShareLinkInput,
  type ShareLinkView,
} from '@codelens/shared';
import { ConflictError, NotFoundError, UnauthorizedError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit-logs/audit.service';
import { TokenCryptoService } from '../auth/token-crypto.service';

/** A share link resolved from a presented token, with its tenant attached. */
export interface ResolvedShareLink {
  id: string;
  organizationId: string;
  pullRequestId: string;
  scope: ShareScope;
  redactCode: boolean;
  expiresAt: Date;
  viewCount: number;
}

/**
 * Time-limited, unauthenticated access to a single review.
 *
 * This is the only path in the product that serves tenant data without an authenticated
 * actor, so it is built to fail closed:
 *
 * TOKENS ARE STORED HASHED. 32 random bytes, kept as sha256, with the raw value returned
 * exactly once at creation. A leaked database gives an attacker no usable links. Plain sha256
 * rather than bcrypt is right here for the reason documented on `TokenCryptoService.hashToken`:
 * there is no low-entropy secret to slow down guessing against.
 *
 * REVOCATION IS A ROW UPDATE, NOT A DELETE. `revokedAt` is set instead of removing the row, so
 * "who shared this, when, and when was it cut off" survives revocation. A deleted share link
 * would erase exactly the evidence an incident review needs.
 *
 * EVERY VIEW IS AUDITED. A forwarded link is otherwise invisible; the view count and the audit
 * entries are the only trace that data left the organization.
 */
@Injectable()
export class ShareLinksService {
  private readonly logger = new Logger(ShareLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly crypto: TokenCryptoService,
    private readonly audit: AuditService,
  ) {}

  async create(params: {
    organizationId: string;
    pullRequestId: string;
    userId: string;
    input: CreateShareLinkInput;
    traceId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<ShareLinkView & { token: string }> {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: params.pullRequestId, organizationId: params.organizationId },
      select: { id: true, number: true, repository: { select: { fullName: true, private: true } } },
    });

    if (!pullRequest) throw new NotFoundError('Pull request', params.pullRequestId);

    const { token, hash } = this.crypto.generateToken(32);

    const expiresAt = new Date(Date.now() + params.input.expiresInHours * 3600 * 1000);

    const passphraseHash = params.input.passphrase
      ? await bcrypt.hash(params.input.passphrase, BCRYPT_ROUNDS)
      : null;

    const row = await this.prisma.unscoped.shareLink.create({
      data: {
        organizationId: params.organizationId,
        pullRequestId: params.pullRequestId,
        createdById: params.userId,
        tokenHash: hash,
        scope: params.input.scope,
        redactCode: params.input.redactCode,
        passphraseHash,
        expiresAt,
      },
      include: { createdBy: { select: { id: true, name: true } } },
    });

    await this.audit.record({
      organizationId: params.organizationId,
      action: AuditAction.SHARE_LINK_CREATED,
      actorId: params.userId,
      resourceType: 'ShareLink',
      resourceId: row.id,
      description:
        `Created a ${params.input.scope} share link for ` +
        `${pullRequest.repository.fullName}#${pullRequest.number}, expiring ` +
        `${expiresAt.toISOString()}` +
        (passphraseHash ? ', passphrase protected' : '') +
        (params.input.redactCode ? ', code redacted' : ''),
      metadata: {
        pullRequestId: params.pullRequestId,
        scope: params.input.scope,
        redactCode: params.input.redactCode,
        hasPassphrase: passphraseHash !== null,
        expiresAt: expiresAt.toISOString(),
        repositoryIsPrivate: pullRequest.repository.private,
        // The raw token is deliberately absent. AuditService would redact a key named
        // "token" anyway, but it is never passed in the first place.
      },
      traceId: params.traceId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    if (pullRequest.repository.private && params.input.scope === ShareScope.FULL) {
      this.logger.warn(
        `Share link ${row.id} grants FULL access to a private repository ` +
          `(${pullRequest.repository.fullName}) to anyone holding the URL.`,
      );
    }

    // The only moment the raw token is available. `url` carries it here and nowhere else.
    return {
      ...toShareLinkView(row, this.config.webUrl),
      url: shareUrlFor(this.config.webUrl, token),
      token,
    };
  }

  async list(organizationId: string, pullRequestId: string): Promise<ShareLinkView[]> {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: pullRequestId, organizationId }, select: { id: true },
    });
    if (!pullRequest) throw new NotFoundError('Review session', pullRequestId);

    const rows = await this.prisma.unscoped.shareLink.findMany({
      where: { pullRequestId, organizationId },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => toShareLinkView(row, this.config.webUrl));
  }

  async revoke(params: {
    organizationId: string;
    pullRequestId: string;
    shareLinkId: string;
    userId: string;
    traceId: string;
  }): Promise<ShareLinkView> {
    const existing = await this.prisma.unscoped.shareLink.findFirst({
      // pullRequestId as well as the id, so a link id from another pull request cannot be
      // revoked through this session's route even within the same organization.
      where: {
        id: params.shareLinkId,
        pullRequestId: params.pullRequestId,
        organizationId: params.organizationId,
      },
      select: { id: true, revokedAt: true, scope: true },
    });

    if (!existing) throw new NotFoundError('Share link', params.shareLinkId);

    if (existing.revokedAt) {
      throw new ConflictError('This share link was already revoked', {
        revokedAt: existing.revokedAt.toISOString(),
      });
    }

    const row = await this.prisma.unscoped.shareLink.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
      include: { createdBy: { select: { id: true, name: true } } },
    });

    await this.audit.record({
      organizationId: params.organizationId,
      action: AuditAction.SHARE_LINK_REVOKED,
      actorId: params.userId,
      resourceType: 'ShareLink',
      resourceId: row.id,
      description:
        `Revoked a ${existing.scope} share link after ${row.viewCount} view(s). ` +
        `The URL no longer resolves.`,
      metadata: {
        pullRequestId: params.pullRequestId,
        viewCount: row.viewCount,
        lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      },
      traceId: params.traceId,
    });

    return toShareLinkView(row, this.config.webUrl);
  }

  /**
   * Resolve a presented token to a usable link, or refuse.
   *
   * Every rejection is a 404 with the same message. Distinguishing "no such link" from
   * "expired" from "revoked" would confirm to someone holding a dead URL that it once pointed
   * at something real, and distinguishing "wrong organization" would be worse still. The
   * caller gets one answer: this link does not work.
   *
   * The exception is a passphrase, which is reported as 401 with a distinct code — the holder
   * of the link already knows it exists, and they need to be told to supply the passphrase.
   */
  async resolve(token: string, passphrase: string | null): Promise<ResolvedShareLink> {
    // Indexed lookup on the hash. The token itself is never stored or compared, so there is no
    // scan and nothing to leak through comparison timing.
    const row = await this.prisma.unscoped.shareLink.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      select: {
        id: true,
        organizationId: true,
        pullRequestId: true,
        scope: true,
        redactCode: true,
        passphraseHash: true,
        expiresAt: true,
        revokedAt: true,
        viewCount: true,
      },
    });

    if (!row || row.revokedAt !== null || row.expiresAt <= new Date()) {
      throw new NotFoundError('Share link');
    }

    if (row.passphraseHash) {
      if (!passphrase) {
        throw new UnauthorizedError(
          'This shared review is passphrase protected. Send the passphrase in the ' +
            'X-Share-Passphrase header.',
        );
      }

      if (!(await bcrypt.compare(passphrase, row.passphraseHash))) {
        throw new UnauthorizedError('That passphrase is not correct.');
      }
    }

    return {
      id: row.id,
      organizationId: row.organizationId,
      pullRequestId: row.pullRequestId,
      scope: row.scope,
      redactCode: row.redactCode,
      expiresAt: row.expiresAt,
      viewCount: row.viewCount,
    };
  }

  /** Record a successful view. Best-effort: a counter must not fail the read. */
  async recordView(
    link: ResolvedShareLink,
    meta: { ipAddress: string | null; userAgent: string | null; traceId: string },
  ): Promise<void> {
    try {
      await this.prisma.unscoped.shareLink.update({
        where: { id: link.id },
        data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record a view for share link ${link.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.audit.record({
      organizationId: link.organizationId,
      action: AuditAction.SHARE_LINK_VIEWED,
      // No actor: that is the point of the entry. actorType falls through to SYSTEM, and the
      // IP and user agent are the only identifying information available.
      actorId: null,
      resourceType: 'ShareLink',
      resourceId: link.id,
      description: `Shared review viewed anonymously (view ${link.viewCount + 1})`,
      metadata: { pullRequestId: link.pullRequestId, scope: link.scope },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      traceId: meta.traceId,
    });
  }
}

function toShareLinkView(
  row: {
    id: string;
    scope: ShareScope;
    redactCode: boolean;
    passphraseHash: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    viewCount: number;
    lastViewedAt: Date | null;
    createdAt: Date;
    createdBy: { id: string; name: string };
  },
  webUrl: string,
): ShareLinkView {
  return {
    id: row.id,
    /**
     * Empty except on the response that created the link.
     *
     * Only the sha256 of the token is stored, so the URL is unrecoverable by design. Listing
     * links shows what exists and lets it be revoked; someone who mislaid a URL gets a new
     * link, which leaves a fresh audit entry naming who re-shared it. Returning a
     * reconstructable URL would mean the database held something sufficient to read the
     * review, which is exactly what hashing the token avoids.
     */
    url: '',
    scope: row.scope,
    redactCode: row.redactCode,
    hasPassphrase: row.passphraseHash !== null,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the full shareable URL. Only reachable at creation, when the token still exists. */
export function shareUrlFor(webUrl: string, token: string): string {
  return `${webUrl.replace(/\/$/, '')}/shared/review/${token}`;
}
