import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { IndexStatus, QUEUE_NAMES } from '@codelens/shared';
import type { Job } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { RagService } from '../../rag/rag.service';
import { classifyJobError } from '../queue.service';
import type { IndexRepositoryJobData, ManagedQueue } from '../queue.types';
import { BaseQueueProcessor } from './base.processor';

/**
 * Repository indexing.
 *
 * This is the job that makes indexing usable at all. Indexing a real repository means
 * fetching hundreds or thousands of files from GitHub and embedding them, which does not
 * fit in an HTTP request — the previous inline endpoint worked only because it was being
 * tested on small repositories.
 *
 * `lockDuration` is generous for the same reason as the review queue: embedding a large
 * batch is a single long await, and a stall would restart the whole index.
 */
@Processor(QUEUE_NAMES.REPO_INDEX, { autorun: false, lockDuration: 600_000 })
export class RepoIndexProcessor extends BaseQueueProcessor<IndexRepositoryJobData> {
  protected readonly queueName: ManagedQueue = QUEUE_NAMES.REPO_INDEX;
  protected readonly logger = new Logger(RepoIndexProcessor.name);

  constructor(
    config: AppConfigService,
    private readonly rag: RagService,
  ) {
    super(config);
  }

  async process(job: Job<IndexRepositoryJobData>): Promise<{
    repositoryId: string;
    status: string;
    filesProcessed: number;
    chunksCreated: number;
    chunksReused: number;
    embeddingsGenerated: number;
    estimatedCostCents: number;
    cacheHitRate: number;
  }> {
    const data = job.data;
    let percent = 1;

    await this.report(job, { percent: 1, stage: 'DISCOVERING', message: 'Listing repository files' });

    try {
      const progress = await this.rag.indexRepository({
        organizationId: data.organizationId,
        repositoryId: data.repositoryId,
        userId: data.userId,
        force: data.force,
        ...(data.maxFiles === null ? {} : { maxFiles: data.maxFiles }),
        includePaths: data.includePaths,
        onProgress: (partial) => {
          const discovered = partial.filesDiscovered ?? 0;
          const processed = (partial.filesProcessed ?? 0) + (partial.filesSkipped ?? 0);
          percent = discovered > 0 ? Math.min(99, Math.round((processed / discovered) * 100)) : 5;

          void this.report(job, {
            // Clamped below 99 so the bar never reads complete while work remains; the
            // final 100 is written only after the index run is committed.
            percent,
            stage: 'INDEXING',
            message:
              `${processed}/${discovered} files, ${partial.chunksCreated ?? 0} chunks, ` +
              `${partial.chunksReused ?? 0} reused`,
          });
        },
      });

      if (progress.status !== IndexStatus.INDEXED) {
        await this.report(job, { percent, stage: 'FAILED', message: 'Repository indexing failed' });
        throw new Error('Repository indexing failed; see the index run diagnostics');
      }

      await this.report(job, { percent: 100, stage: 'DONE', message: 'Index complete' });

      return {
        repositoryId: data.repositoryId,
        status: progress.status,
        filesProcessed: progress.filesProcessed,
        chunksCreated: progress.chunksCreated,
        chunksReused: progress.chunksReused,
        embeddingsGenerated: progress.embeddingsGenerated,
        estimatedCostCents: progress.estimatedCostCents,
        cacheHitRate: Number(progress.cacheHitRate.toFixed(3)),
      };
    } catch (error) {
      // RagService already wrote IndexStatus.FAILED and the error onto both the IndexRun
      // and the Repository, so the failure is visible in the UI regardless of the retry
      // decision made here.
      throw classifyJobError(error);
    }
  }

  /**
   * Serialised per worker.
   *
   * Indexing is bounded by the GitHub file-content API and the embedding provider, both of
   * which rate-limit per account rather than per connection. Running several indexes
   * concurrently in one process does not go faster, it just reaches the secondary rate
   * limit sooner — and that takes longer to recover from than the index takes to run.
   */
  protected override concurrency(): number {
    return 1;
  }
}
