import { Injectable, Logger } from '@nestjs/common';
import { GithubClient } from '@codelens/github';
import { GithubNotConnectedError, NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TokenCryptoService } from './token-crypto.service';

/**
 * Resolves a usable {@link GithubClient} for a user or a repository.
 *
 * The non-obvious problem this solves: background analysis jobs have no request and
 * therefore no "current user", but they still need a GitHub token to fetch a diff.
 * Whose token should a queued job use?
 *
 * The answer implemented here, in order of preference:
 *
 *   1. the user who triggered the run, if they have a working GitHub connection
 *   2. the user who connected the repository to CodeLens
 *   3. any other member of the organization with a token
 *
 * Step 3 is a deliberate and slightly uncomfortable choice, so it is worth being
 * explicit. It means member A's token can be used to fetch a diff on behalf of an
 * analysis triggered by member B. That is acceptable because both are members of the
 * same organization and the repository was connected to that organization on purpose,
 * and because the alternative is that analysis silently stops working when one person
 * leaves the company. The audit log records which account's token was used, so the
 * attribution is never lost.
 *
 * The proper long-term fix is a GitHub App installation token, which belongs to the
 * organization rather than to any person. That is the documented upgrade path.
 */
@Injectable()
export class GithubClientFactory {
  private readonly logger = new Logger(GithubClientFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: TokenCryptoService,
    private readonly redis: RedisService,
  ) {}

  /** Client for a specific user. Throws if they have no usable token. */
  async forUser(userId: string): Promise<GithubClient> {
    const account = await this.prisma.unscoped.account.findFirst({
      where: { userId, provider: 'github' },
      select: { accessTokenEncrypted: true, tokenExpiresAt: true, providerLogin: true },
    });

    if (!account) {
      throw new GithubNotConnectedError(
        'Connect your GitHub account to access repositories and pull requests.',
      );
    }

    if (account.tokenExpiresAt && account.tokenExpiresAt < new Date()) {
      throw new GithubNotConnectedError(
        'Your GitHub token has expired. Reconnect your GitHub account.',
      );
    }

    const token = this.crypto.decrypt(account.accessTokenEncrypted);

    if (!token) {
      throw new GithubNotConnectedError(
        'Your stored GitHub token could not be read. Reconnect your GitHub account.',
      );
    }

    return this.build(token, userId);
  }

  /** As {@link forUser}, but returns null instead of throwing. */
  async tryForUser(userId: string): Promise<GithubClient | null> {
    try {
      return await this.forUser(userId);
    } catch {
      return null;
    }
  }

  /**
   * Client capable of reading a repository, with the fallback chain described above.
   *
   * Returns the resolved account so callers can record attribution in the audit log.
   */
  async forRepository(params: {
    repositoryId: string;
    organizationId: string;
    preferUserId?: string | null;
  }): Promise<{ client: GithubClient; actingUserId: string; actingLogin: string | null }> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: params.repositoryId, organizationId: params.organizationId },
      select: { id: true, fullName: true, connectedById: true },
    });

    if (!repository) throw new NotFoundError('Repository', params.repositoryId);

    const candidateIds = [
      params.preferUserId,
      repository.connectedById,
    ].filter((id): id is string => Boolean(id));

    for (const userId of candidateIds) {
      const resolved = await this.resolve(userId);
      if (resolved) return resolved;
    }

    // Last resort: any member of this organization with a working token.
    const members = await this.prisma.unscoped.membership.findMany({
      where: {
        organizationId: params.organizationId,
        userId: { notIn: candidateIds.length > 0 ? candidateIds : ['__none__'] },
      },
      select: { userId: true },
      // Higher roles first: an owner or admin is more likely to hold a token with
      // access to the repository than an arbitrary developer.
      orderBy: { role: 'desc' },
      take: 10,
    });

    for (const member of members) {
      const resolved = await this.resolve(member.userId);

      if (resolved) {
        this.logger.warn(
          `Using the GitHub token of user ${resolved.actingUserId} for repository ` +
            `${repository.fullName}; neither the triggering user nor the connecting user ` +
            `has a usable connection.`,
        );
        return resolved;
      }
    }

    throw new GithubNotConnectedError(
      `No member of this organization has a working GitHub connection, so ` +
        `${repository.fullName} cannot be read. Ask a member to reconnect GitHub.`,
    );
  }

  private async resolve(
    userId: string,
  ): Promise<{ client: GithubClient; actingUserId: string; actingLogin: string | null } | null> {
    const account = await this.prisma.unscoped.account.findFirst({
      where: { userId, provider: 'github' },
      select: { accessTokenEncrypted: true, tokenExpiresAt: true, providerLogin: true },
    });

    if (!account) return null;
    if (account.tokenExpiresAt && account.tokenExpiresAt < new Date()) return null;

    const token = this.crypto.decrypt(account.accessTokenEncrypted);
    if (!token) return null;

    return {
      client: this.build(token, userId),
      actingUserId: userId,
      actingLogin: account.providerLogin,
    };
  }

  private build(token: string, userId: string): GithubClient {
    return new GithubClient({
      accessToken: token,
      // Remaining quota is cached so the UI can warn before a large indexing run
      // exhausts the hourly budget, rather than discovering it half way through.
      onRateLimit: (info) => {
        void this.redis.setJson(
          `ghrl:${userId}`,
          {
            limit: info.limit,
            remaining: info.remaining,
            resetAt: info.resetAt.toISOString(),
            used: info.used,
          },
          300,
        );

        if (info.remaining < 100) {
          this.logger.warn(
            `GitHub rate limit low for user ${userId}: ${info.remaining}/${info.limit} ` +
              `remaining, resets at ${info.resetAt.toISOString()}`,
          );
        }
      },
    });
  }

  /** Cached rate-limit snapshot for a user, for display in settings. */
  async rateLimitFor(userId: string): Promise<{
    limit: number;
    remaining: number;
    resetAt: string;
    used: number;
  } | null> {
    return this.redis.getJson(`ghrl:${userId}`);
  }
}
