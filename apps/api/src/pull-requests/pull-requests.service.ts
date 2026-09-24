import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  MAX_FILES_PER_REVIEW,
  PullRequestState,
  classifyFile,
  paginate,
  type CommitView,
  type FileFlag,
  type ListPullRequestsQuery,
  type Paginated,
  type PullRequestDetail,
  type PullRequestFileView,
  type PullRequestListItem,
  type RiskLevel,
} from '@codelens/shared';
import { ReviewVerdict, type Prisma } from '@codelens/database';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit-logs/audit.service';
import { GithubClientFactory } from '../auth/github-client.factory';

@Injectable()
export class PullRequestsService {
  private readonly logger = new Logger(PullRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
    private readonly audit: AuditService,
  ) {}

  async list(
    organizationId: string,
    query: ListPullRequestsQuery & { repositoryId?: string },
  ): Promise<Paginated<PullRequestListItem>> {
    const where: Prisma.PullRequestWhereInput = {
      organizationId,
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.authorLogin ? { authorLogin: query.authorLogin } : {}),
      ...(query.riskLevel ? { latestRiskLevel: query.riskLevel } : {}),
      ...(query.analyzedOnly ? { runs: { some: { status: 'COMPLETED' } } } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { headRef: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.PullRequestOrderByWithRelationInput =
      query.sortBy === 'riskScore'
        ? // Nulls last: an unanalysed PR sorting above a high-risk one would be actively
          // misleading when the user asked to see risk first.
          { latestRiskScore: { sort: query.sortOrder, nulls: 'last' } }
        : query.sortBy === 'additions'
          ? { additions: query.sortOrder }
          : query.sortBy === 'createdAt'
            ? { githubCreatedAt: query.sortOrder }
            : { githubUpdatedAt: query.sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.unscoped.pullRequest.findMany({
        where,
        include: PR_LIST_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.unscoped.pullRequest.count({ where }),
    ]);

    return paginate(rows.map(toListItem), total, query);
  }

  async findOne(organizationId: string, pullRequestId: string): Promise<PullRequestDetail> {
    const row = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: pullRequestId, organizationId },
      include: {
        ...PR_LIST_INCLUDE,
        repository: { select: { id: true, fullName: true, defaultBranch: true } },
        files: { orderBy: [{ changes: 'desc' }, { filename: 'asc' }] },
        commits: { orderBy: { authoredAt: 'asc' } },
      },
    });

    if (!row) throw new NotFoundError('Pull request', pullRequestId);

    // Finding counts per file, from the most recent completed run, so the file tree can
    // show where the problems are without loading every finding.
    const latestRun = await this.prisma.unscoped.reviewRun.findFirst({
      where: { pullRequestId, status: { in: ['COMPLETED', 'PARTIAL'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const findingCounts = latestRun
      ? await this.prisma.unscoped.staticFinding.groupBy({
          by: ['path'],
          where: { reviewRunId: latestRun.id, preexisting: false },
          _count: { _all: true },
        })
      : [];

    const countsByPath = new Map(
      findingCounts
        .filter((row) => row.path !== null)
        .map((row) => [row.path as string, row._count._all]),
    );

    return {
      ...toListItem(row),
      body: row.body,
      repository: row.repository,
      mergeable: row.mergeable,
      merged: row.merged,
      mergedAt: row.mergedAt?.toISOString() ?? null,
      headSha: row.headSha,
      baseSha: row.baseSha,
      labels: row.labels,
      files: row.files.map((file) => toFileView(file, countsByPath.get(file.filename) ?? 0)),
      commits: row.commits.map(toCommitView),
    };
  }

  /**
   * Import a pull request from GitHub, including its diff and commits.
   *
   * Idempotent: re-importing refreshes files and commits rather than duplicating them,
   * which matters because the analysis pipeline calls this to guarantee a diff is present
   * before it starts.
   */
  async importFromGithub(
    organizationId: string,
    params: { repositoryId: string; number: number; userId: string | null },
  ): Promise<PullRequestDetail> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: params.repositoryId, organizationId },
      select: { id: true, fullName: true },
    });

    if (!repository) throw new NotFoundError('Repository', params.repositoryId);

    const { client } = await this.github.forRepository({
      repositoryId: params.repositoryId,
      organizationId,
      preferUserId: params.userId,
    });

    const [pull, files, commits] = await Promise.all([
      client.getPullRequest(repository.fullName, params.number),
      client.getPullRequestFiles(repository.fullName, params.number, {
        maxFiles: MAX_FILES_PER_REVIEW,
      }),
      client.getPullRequestCommits(repository.fullName, params.number),
    ]);

    const authorUserId = await this.resolveAuthorUserId(organizationId, pull.authorLogin);

    const state: PullRequestState = pull.merged
      ? PullRequestState.MERGED
      : pull.state === 'closed'
        ? PullRequestState.CLOSED
        : pull.draft
          ? PullRequestState.DRAFT
          : PullRequestState.OPEN;

    const pullRequest = await this.prisma.unscoped.pullRequest.upsert({
      where: { repositoryId_number: { repositoryId: params.repositoryId, number: params.number } },
      create: {
        organizationId,
        repositoryId: params.repositoryId,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state,
        draft: pull.draft,
        htmlUrl: pull.htmlUrl,
        authorLogin: pull.authorLogin,
        authorAvatarUrl: pull.authorAvatarUrl,
        authorUserId,
        headRef: pull.headRef,
        headSha: pull.headSha,
        baseRef: pull.baseRef,
        baseSha: pull.baseSha,
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        changedFiles: pull.changedFiles ?? files.length,
        commitCount: pull.commitCount ?? commits.length,
        mergeable: pull.mergeable ?? null,
        merged: pull.merged,
        mergedAt: pull.mergedAt ? new Date(pull.mergedAt) : null,
        closedAt: pull.closedAt ? new Date(pull.closedAt) : null,
        labels: pull.labels,
        githubCreatedAt: new Date(pull.createdAt),
        githubUpdatedAt: new Date(pull.updatedAt),
      },
      update: {
        title: pull.title,
        body: pull.body,
        state,
        draft: pull.draft,
        authorUserId,
        headRef: pull.headRef,
        headSha: pull.headSha,
        baseSha: pull.baseSha,
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        changedFiles: pull.changedFiles ?? files.length,
        commitCount: pull.commitCount ?? commits.length,
        mergeable: pull.mergeable ?? null,
        merged: pull.merged,
        mergedAt: pull.mergedAt ? new Date(pull.mergedAt) : null,
        closedAt: pull.closedAt ? new Date(pull.closedAt) : null,
        labels: pull.labels,
        githubUpdatedAt: new Date(pull.updatedAt),
      },
      select: { id: true },
    });

    // Files are replaced wholesale. A force-push can remove files entirely, and diffing
    // would leave stale rows describing changes that no longer exist in the PR.
    await this.prisma.unscoped.$transaction(async (tx) => {
      await tx.pullRequestFile.deleteMany({ where: { pullRequestId: pullRequest.id } });

      if (files.length > 0) {
        await tx.pullRequestFile.createMany({
          data: files.map((file) => ({
            pullRequestId: pullRequest.id,
            filename: file.filename,
            previousFilename: file.previousFilename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            language: file.language,
            flags: file.flags,
            patch: file.patch,
            patchTruncated: file.patchTruncated,
            binary: file.binary,
            touchedLines: file.touchedLines,
          })),
        });
      }

      for (const commit of commits) {
        await tx.commit.upsert({
          where: { pullRequestId_sha: { pullRequestId: pullRequest.id, sha: commit.sha } },
          create: {
            pullRequestId: pullRequest.id,
            sha: commit.sha,
            message: commit.message,
            authorName: commit.authorName,
            authorLogin: commit.authorLogin,
            authoredAt: new Date(commit.authoredAt),
            additions: commit.additions,
            deletions: commit.deletions,
          },
          update: { message: commit.message },
        });
      }
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.PR_SYNCED,
      actorId: params.userId,
      resourceType: 'PullRequest',
      resourceId: pullRequest.id,
      description: `Imported ${repository.fullName}#${params.number} with ${files.length} changed file(s)`,
      metadata: { number: params.number, files: files.length, commits: commits.length },
    });

    return this.findOne(organizationId, pullRequest.id);
  }

  /** Raw diff rows, used by the analysis pipeline. */
  async getFiles(organizationId: string, pullRequestId: string) {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: pullRequestId, organizationId },
      select: { id: true },
    });

    if (!pullRequest) throw new NotFoundError('Pull request', pullRequestId);

    return this.prisma.unscoped.pullRequestFile.findMany({
      where: { pullRequestId },
      orderBy: { filename: 'asc' },
    });
  }

  private async resolveAuthorUserId(
    organizationId: string,
    login: string,
  ): Promise<string | null> {
    const account = await this.prisma.unscoped.account.findFirst({
      where: {
        provider: 'github',
        providerLogin: login,
        user: { memberships: { some: { organizationId } } },
      },
      select: { userId: true },
    });

    return account?.userId ?? null;
  }
}

const PR_LIST_INCLUDE = {
  reviews: { select: { verdict: true, headSha: true } },
  runs: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, stage: true, finishedAt: true },
  },
  files: { select: { flags: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.PullRequestInclude;

type PullRequestWithRelations = Prisma.PullRequestGetPayload<{ include: typeof PR_LIST_INCLUDE }>;

function toListItem(row: PullRequestWithRelations): PullRequestListItem {
  const latestRun = row.runs[0];

  // Verdicts on a previous head are excluded: approval of code that has since changed is
  // not approval of the current code.
  const currentReviews = row.reviews.filter((review) => review.headSha === row.headSha);

  const flags = new Set<FileFlag>();
  for (const file of row.files) {
    for (const flag of file.flags) flags.add(flag as FileFlag);
  }

  return {
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state as PullRequestState,
    author: {
      login: row.authorLogin,
      avatarUrl: row.authorAvatarUrl,
      userId: row.authorUserId,
    },
    headRef: row.headRef,
    baseRef: row.baseRef,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    commitCount: row.commitCount,
    draft: row.draft,
    htmlUrl: row.htmlUrl,
    createdAt: row.githubCreatedAt.toISOString(),
    updatedAt: row.githubUpdatedAt.toISOString(),
    risk:
      row.latestRiskScore !== null && row.latestRiskLevel !== null
        ? {
            score: row.latestRiskScore,
            level: row.latestRiskLevel as RiskLevel,
            // The precise model version lives on MlPrediction; the list view only needs
            // to know a score exists.
            modelVersion: 'latest',
          }
        : null,
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          stage: latestRun.stage,
          finishedAt: latestRun.finishedAt?.toISOString() ?? null,
        }
      : null,
    humanReviewSummary: {
      approvals: currentReviews.filter((r) => r.verdict === ReviewVerdict.APPROVED).length,
      changesRequested: currentReviews.filter(
        (r) => r.verdict === ReviewVerdict.CHANGES_REQUESTED,
      ).length,
      needsDiscussion: currentReviews.filter(
        (r) => r.verdict === ReviewVerdict.NEEDS_DISCUSSION,
      ).length,
    },
    unresolvedCommentCount: row._count.comments,
    flags: [...flags],
  };
}

function toFileView(
  file: {
    id: string;
    filename: string;
    previousFilename: string | null;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    language: string;
    flags: string[];
    patch: string | null;
    patchTruncated: boolean;
    binary: boolean;
  },
  findingCount: number,
): PullRequestFileView {
  return {
    id: file.id,
    filename: file.filename,
    previousFilename: file.previousFilename,
    status: file.status as PullRequestFileView['status'],
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    language: file.language,
    // Recomputed rather than trusted from the row so a classifier improvement applies to
    // already-imported pull requests without a backfill.
    flags: file.flags.length > 0 ? (file.flags as FileFlag[]) : classifyFile(file.filename),
    patch: file.patch,
    patchTruncated: file.patchTruncated,
    binary: file.binary,
    findingCount,
  };
}

function toCommitView(commit: {
  sha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  authoredAt: Date;
  additions: number | null;
  deletions: number | null;
}): CommitView {
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    message: commit.message,
    authorName: commit.authorName,
    authorLogin: commit.authorLogin,
    authoredAt: commit.authoredAt.toISOString(),
    additions: commit.additions,
    deletions: commit.deletions,
  };
}
