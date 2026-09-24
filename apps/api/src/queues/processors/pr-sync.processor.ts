import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@codelens/shared';
import type { Job } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RepositoriesService } from '../../repositories/repositories.service';
import { classifyJobError } from '../queue.service';
import type { ManagedQueue, SyncPullRequestsJobData } from '../queue.types';
import { BaseQueueProcessor } from './base.processor';

interface SyncOutcome {
  repositoryId: string;
  fullName: string;
  synced: number;
  created: number;
  error: string | null;
}

/**
 * GitHub pull request synchronisation.
 *
 * Pulls metadata and open pull requests for one repository, or for every connected
 * repository when `repositoryId` is null. The organization-wide variant is the reason this
 * queue exists: doing it inline meant the dashboard refresh button held an HTTP connection
 * open for the duration of N sequential GitHub round trips.
 */
@Processor(QUEUE_NAMES.PR_SYNC, { autorun: false, lockDuration: 300_000 })
export class PrSyncProcessor extends BaseQueueProcessor<SyncPullRequestsJobData> {
  protected readonly queueName: ManagedQueue = QUEUE_NAMES.PR_SYNC;
  protected readonly logger = new Logger(PrSyncProcessor.name);

  constructor(
    config: AppConfigService,
    private readonly repositories: RepositoriesService,
    private readonly prisma: PrismaService,
  ) {
    super(config);
  }

  async process(job: Job<SyncPullRequestsJobData>): Promise<{
    repositories: number;
    totalSynced: number;
    totalCreated: number;
    failed: number;
    results: SyncOutcome[];
  }> {
    const data = job.data;

    try {
      const targets = data.repositoryId
        ? await this.oneRepository(data.organizationId, data.repositoryId)
        : await this.allRepositories(data.organizationId);

      const results: SyncOutcome[] = [];

      for (const [index, repository] of targets.entries()) {
        await this.report(job, {
          percent: Math.round((index / Math.max(1, targets.length)) * 100),
          stage: 'SYNCING',
          message: `Syncing ${repository.fullName} (${index + 1}/${targets.length})`,
        });

        try {
          // Sequential, not parallel. Fanning out across repositories burns the GitHub
          // hourly budget in a burst and risks a secondary rate limit, which takes longer
          // to clear than the sync takes to run.
          //
          // A null userId is fine: GithubClientFactory falls back to the account that
          // connected the repository, then to any member with a working token.
          const result = await this.repositories.sync(
            data.organizationId,
            repository.id,
            data.userId,
            { state: data.state, limit: data.limit },
          );

          results.push({
            repositoryId: repository.id,
            fullName: repository.fullName,
            synced: result.pullRequestsSynced,
            created: result.newPullRequests,
            error: null,
          });
        } catch (error) {
          // One repository the token can no longer read must not abort the rest. A
          // partially successful sync is strictly more useful than none.
          const message = error instanceof Error ? error.message : String(error);

          this.logger.warn(`Sync failed for ${repository.fullName}: ${message}`);

          results.push({
            repositoryId: repository.id,
            fullName: repository.fullName,
            synced: 0,
            created: 0,
            error: message,
          });
        }
      }

      await this.report(job, { percent: 100, stage: 'DONE', message: 'Sync complete' });

      return {
        repositories: results.length,
        totalSynced: results.reduce((sum, row) => sum + row.synced, 0),
        totalCreated: results.reduce((sum, row) => sum + row.created, 0),
        failed: results.filter((row) => row.error !== null).length,
        results,
      };
    } catch (error) {
      throw classifyJobError(error);
    }
  }

  private async oneRepository(
    organizationId: string,
    repositoryId: string,
  ): Promise<Array<{ id: string; fullName: string }>> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: repositoryId, organizationId },
      select: { id: true, fullName: true },
    });

    // An empty list rather than a throw: the repository may have been disconnected between
    // enqueue and execution, which is an expected race, not a failure.
    return repository ? [repository] : [];
  }

  private async allRepositories(
    organizationId: string,
  ): Promise<Array<{ id: string; fullName: string }>> {
    return this.prisma.unscoped.repository.findMany({
      where: { organizationId },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
  }

  /** Bounded by the GitHub rate limit, which is per account, so extra concurrency is waste. */
  protected override concurrency(): number {
    return Math.max(1, Math.min(this.config.queue.concurrency, 2));
  }
}
