import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  IndexStatus,
  paginate,
  type ConnectRepositoryInput,
  type GithubRepositoryOption,
  type Paginated,
  type RepositoryView,
} from '@codelens/shared';
import { ConflictError, NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit-logs/audit.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { QueueService } from '../queues/queue.service';

@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
  ) {}

  /**
   * Repositories visible on GitHub, annotated with whether each is already connected.
   *
   * Cached briefly per user: the GitHub call is several paginated requests against a
   * 5000/hour budget, and the repository picker is a list users open repeatedly while
   * deciding what to connect.
   */
  async listAvailable(
    organizationId: string,
    userId: string,
    options: { search?: string; refresh?: boolean } = {},
  ): Promise<GithubRepositoryOption[]> {
    const cacheKey = `ghrepos:${userId}`;

    let available = options.refresh
      ? null
      : await this.redis.getJson<Omit<GithubRepositoryOption, 'connected'>[]>(cacheKey);

    if (!available) {
      const client = await this.github.forUser(userId);
      available = await client.listAccessibleRepositories();
      await this.redis.setJson(cacheKey, available, 600);
    }

    const connected = await this.prisma.unscoped.repository.findMany({
      where: { organizationId },
      select: { githubId: true },
    });
    const connectedIds = new Set(connected.map((row) => row.githubId));

    const search = options.search?.toLowerCase();

    return available
      .filter((repo) => !search || repo.fullName.toLowerCase().includes(search))
      .map((repo) => ({ ...repo, connected: connectedIds.has(repo.githubId) }));
  }

  async list(
    organizationId: string,
    query: { page: number; pageSize: number; search?: string },
  ): Promise<Paginated<RepositoryView>> {
    const where = {
      organizationId,
      ...(query.search
        ? { fullName: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.unscoped.repository.findMany({
        where,
        include: {
          teams: { include: { team: { select: { id: true, name: true } } } },
          _count: { select: { pullRequests: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.unscoped.repository.count({ where }),
    ]);

    // Open PR counts in one grouped query rather than per repository.
    const openCounts = await this.prisma.unscoped.pullRequest.groupBy({
      by: ['repositoryId'],
      where: { organizationId, state: 'OPEN', repositoryId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const openByRepo = new Map(openCounts.map((row) => [row.repositoryId, row._count._all]));

    return paginate(
      rows.map((row) => toRepositoryView(row, openByRepo.get(row.id) ?? 0)),
      total,
      query,
    );
  }

  async findOne(organizationId: string, repositoryId: string): Promise<RepositoryView> {
    const row = await this.prisma.unscoped.repository.findFirst({
      where: { id: repositoryId, organizationId },
      include: { teams: { include: { team: { select: { id: true, name: true } } } } },
    });

    if (!row) throw new NotFoundError('Repository', repositoryId);

    const openCount = await this.prisma.unscoped.pullRequest.count({
      where: { repositoryId, state: 'OPEN' },
    });

    return toRepositoryView(row, openCount);
  }

  /**
   * Connect a GitHub repository to the organization.
   *
   * Metadata is fetched from GitHub rather than trusted from the request body: the
   * client supplies an id and a name, and accepting those unverified would let a caller
   * create a repository row pointing at something they cannot actually read.
   */
  async connect(
    organizationId: string,
    userId: string,
    input: ConnectRepositoryInput,
    meta: { ipAddress: string | null; userAgent: string | null; traceId: string },
  ): Promise<RepositoryView> {
    const existing = await this.prisma.unscoped.repository.findUnique({
      where: { organizationId_githubId: { organizationId, githubId: input.githubId } },
      select: { id: true, fullName: true },
    });

    if (existing) {
      throw new ConflictError(`${existing.fullName} is already connected`, {
        repositoryId: existing.id,
      });
    }

    const client = await this.github.forUser(userId);
    // Throws GithubError NOT_FOUND if the token cannot see it, which is the
    // authorization check: no separate permission lookup is needed.
    const metadata = await client.getRepositoryMetadata(input.fullName);

    if (metadata.githubId !== input.githubId) {
      throw new ConflictError(
        `${input.fullName} resolves to GitHub id ${metadata.githubId}, not ${input.githubId}. ` +
          `The repository may have been renamed or replaced.`,
      );
    }

    const validTeamIds = await this.filterOrganizationTeams(organizationId, input.teamIds);

    const repository = await this.prisma.unscoped.repository.create({
      data: {
        organizationId,
        githubId: metadata.githubId,
        fullName: metadata.fullName,
        name: metadata.name,
        owner: metadata.owner,
        description: metadata.description,
        private: metadata.private,
        defaultBranch: metadata.defaultBranch,
        primaryLanguage: metadata.primaryLanguage,
        htmlUrl: metadata.htmlUrl,
        connectedById: userId,
        lastSyncedAt: new Date(),
        indexStatus: input.autoIndex ? IndexStatus.QUEUED : IndexStatus.NOT_INDEXED,
        teams: { create: validTeamIds.map((teamId) => ({ teamId })) },
      },
      include: { teams: { include: { team: { select: { id: true, name: true } } } } },
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.REPO_CONNECTED,
      actorId: userId,
      resourceType: 'Repository',
      resourceId: repository.id,
      description: `Connected ${metadata.fullName}${metadata.private ? ' (private)' : ''}`,
      metadata: {
        fullName: metadata.fullName,
        private: metadata.private,
        primaryLanguage: metadata.primaryLanguage,
        autoIndex: input.autoIndex,
      },
      ...meta,
    });

    // IndexStatus.QUEUED has to mean something. Until this enqueue existed, autoIndex wrote
    // QUEUED and nothing ever picked it up, so the repository sat in a status that looked
    // like progress forever.
    if (input.autoIndex) {
      await this.queues
        .enqueueIndex({
          organizationId,
          repositoryId: repository.id,
          userId,
          traceId: meta.traceId,
          force: false,
          maxFiles: null,
          includePaths: [],
        })
        .catch((error: unknown) => {
          // Connecting succeeded; only the follow-up index failed to queue. Failing the
          // whole request here would leave a connected repository the caller believes was
          // rejected. Reflected in indexStatus instead.
          this.logger.warn(
            `Connected ${metadata.fullName} but could not queue indexing: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );

          return this.prisma.unscoped.repository
            .update({
              where: { id: repository.id },
              data: {
                indexStatus: IndexStatus.NOT_INDEXED,
                indexError: 'Indexing could not be queued. Trigger it manually.',
              },
            })
            .then(() => undefined);
        });
    }

    return toRepositoryView(repository, 0);
  }

  async disconnect(
    organizationId: string,
    repositoryId: string,
    userId: string,
  ): Promise<void> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: repositoryId, organizationId },
      select: { id: true, fullName: true },
    });

    if (!repository) throw new NotFoundError('Repository', repositoryId);

    // Cascades to pull requests, runs, findings and RAG chunks by schema definition.
    // Deliberate: leaving orphaned analysis for a repository the organization no longer
    // has access to would be both a storage leak and a privacy problem.
    await this.prisma.unscoped.repository.delete({ where: { id: repositoryId } });

    await this.audit.record({
      organizationId,
      action: AuditAction.REPO_DISCONNECTED,
      actorId: userId,
      resourceType: 'Repository',
      resourceId: repositoryId,
      description: `Disconnected ${repository.fullName} and deleted its analysis history`,
    });
  }

  /**
   * Refresh repository metadata and pull requests from GitHub.
   *
   * Upserts rather than replaces, so existing analysis history survives a sync. A PR
   * whose head SHA changed has its denormalised risk cleared, because a score computed
   * against different code is worse than no score.
   */
  async sync(
    organizationId: string,
    repositoryId: string,
    /**
     * Null for queue-driven syncs, which have no human actor. GithubClientFactory then
     * falls back to the account that connected the repository, and the audit entry records
     * a system-initiated sync.
     */
    userId: string | null,
    options: { state?: 'open' | 'closed' | 'all'; limit?: number } = {},
  ): Promise<{ repository: RepositoryView; pullRequestsSynced: number; newPullRequests: number }> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: repositoryId, organizationId },
      select: { id: true, fullName: true, connectedById: true },
    });

    if (!repository) throw new NotFoundError('Repository', repositoryId);

    const { client } = await this.github.forRepository({
      repositoryId,
      organizationId,
      preferUserId: userId,
    });

    const metadata = await client.getRepositoryMetadata(repository.fullName);

    await this.prisma.unscoped.repository.update({
      where: { id: repositoryId },
      data: {
        // fullName is refreshed because repositories get renamed; the numeric GitHub id
        // is what actually identifies it.
        fullName: metadata.fullName,
        name: metadata.name,
        owner: metadata.owner,
        description: metadata.description,
        private: metadata.private,
        defaultBranch: metadata.defaultBranch,
        primaryLanguage: metadata.primaryLanguage,
        htmlUrl: metadata.htmlUrl,
        lastSyncedAt: new Date(),
      },
    });

    const pulls = await client.listPullRequests(metadata.fullName, {
      state: options.state ?? 'open',
      limit: options.limit ?? 50,
    });

    let newCount = 0;

    for (const pull of pulls) {
      const existing = await this.prisma.unscoped.pullRequest.findUnique({
        where: { repositoryId_number: { repositoryId, number: pull.number } },
        select: { id: true, headSha: true },
      });

      const state = pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : pull.draft ? 'DRAFT' : 'OPEN';

      // Resolve the GitHub login to a CodeLens user so authorship links up.
      const authorUserId = await this.resolveAuthorUserId(organizationId, pull.authorLogin);

      const common = {
        title: pull.title,
        body: pull.body,
        state: state as 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT',
        draft: pull.draft,
        htmlUrl: pull.htmlUrl,
        authorLogin: pull.authorLogin,
        authorAvatarUrl: pull.authorAvatarUrl,
        authorUserId,
        headRef: pull.headRef,
        headSha: pull.headSha,
        baseRef: pull.baseRef,
        baseSha: pull.baseSha,
        merged: pull.merged,
        mergedAt: pull.mergedAt ? new Date(pull.mergedAt) : null,
        closedAt: pull.closedAt ? new Date(pull.closedAt) : null,
        labels: pull.labels,
        githubUpdatedAt: new Date(pull.updatedAt),
      };

      if (existing) {
        const headChanged = existing.headSha !== pull.headSha;

        await this.prisma.unscoped.$transaction(async (tx) => {
          await tx.pullRequestImportFence.upsert({
            where: { repositoryId_number: { repositoryId, number: pull.number } },
            create: { repositoryId, number: pull.number, generation: 1 },
            update: { generation: { increment: 1 } },
          });
          await tx.pullRequest.update({
            where: { id: existing.id },
            data: {
              ...common,
              diffBaseSha: null,
              diffHeadSha: null,
              diffMergeBaseSha: null,
              diffVerifiedAt: null,
              // A risk score computed against a previous head is misleading, so it is
              // cleared rather than carried forward.
              ...(headChanged ? { latestRiskScore: null, latestRiskLevel: null } : {}),
            },
          });
        });
      } else {
        await this.prisma.unscoped.pullRequest.create({
          data: {
            ...common,
            organizationId,
            repositoryId,
            number: pull.number,
            githubCreatedAt: new Date(pull.createdAt),
          },
        });
        newCount += 1;
      }
    }

    await this.audit.record({
      organizationId,
      action: AuditAction.PR_SYNCED,
      actorId: userId,
      resourceType: 'Repository',
      resourceId: repositoryId,
      description:
        `Synced ${pulls.length} pull request(s) from ${metadata.fullName}` +
        (newCount > 0 ? `, ${newCount} new` : ''),
      metadata: { synced: pulls.length, created: newCount, state: options.state ?? 'open' },
    });

    return {
      repository: await this.findOne(organizationId, repositoryId),
      pullRequestsSynced: pulls.length,
      newPullRequests: newCount,
    };
  }

  /** Map a GitHub login to an organization member, if one is linked. */
  private async resolveAuthorUserId(
    organizationId: string,
    login: string,
  ): Promise<string | null> {
    const account = await this.prisma.unscoped.account.findFirst({
      where: {
        provider: 'github',
        providerLogin: login,
        // Only link to a user who is actually a member of this organization.
        user: { memberships: { some: { organizationId } } },
      },
      select: { userId: true },
    });

    return account?.userId ?? null;
  }

  private async filterOrganizationTeams(
    organizationId: string,
    teamIds: string[],
  ): Promise<string[]> {
    if (teamIds.length === 0) return [];

    const teams = await this.prisma.unscoped.team.findMany({
      where: { organizationId, id: { in: teamIds } },
      select: { id: true },
    });

    return teams.map((team) => team.id);
  }
}

function toRepositoryView(
  row: {
    id: string;
    githubId: number;
    fullName: string;
    name: string;
    owner: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    primaryLanguage: string | null;
    indexStatus: IndexStatus;
    indexedAt: Date | null;
    indexError: string | null;
    indexedChunkCount: number;
    lastSyncedAt: Date | null;
    createdAt: Date;
    teams: Array<{ team: { id: string; name: string } }>;
  },
  openPullRequestCount: number,
): RepositoryView {
  return {
    id: row.id,
    githubId: row.githubId,
    fullName: row.fullName,
    name: row.name,
    owner: row.owner,
    description: row.description,
    private: row.private,
    defaultBranch: row.defaultBranch,
    primaryLanguage: row.primaryLanguage,
    indexStatus: row.indexStatus,
    indexedAt: row.indexedAt?.toISOString() ?? null,
    indexedChunkCount: row.indexedChunkCount,
    indexError: row.indexError,
    openPullRequestCount,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    connectedAt: row.createdAt.toISOString(),
    teams: row.teams.map((entry) => entry.team),
  };
}
