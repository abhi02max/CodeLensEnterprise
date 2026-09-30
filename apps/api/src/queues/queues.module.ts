import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { JobsController } from './jobs.controller';
import { QueueService } from './queue.service';
import { MANAGED_QUEUES } from './queue.types';

/**
 * Producer half of the queue layer.
 *
 * Split from {@link WorkersModule} on purpose. Producers must be injectable from anywhere —
 * `RepositoriesService` enqueues an index job, `AnalysisController` enqueues a run — while
 * consumers depend on the services those same modules provide. Keeping them in one module
 * creates a dependency cycle that can only be papered over with `forwardRef`, and the
 * forward reference then hides the fact that importing the queue pulls in the entire
 * analysis pipeline.
 *
 * Global so any module can enqueue without importing anything.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          url: config.redisUrl,
          // Blocking workers must tolerate reconnects; readiness separately bounds probes.
          maxRetriesPerRequest: null,
        },
        // Namespaced so a shared Redis can host more than one environment without one
        // deployment's workers picking up another's jobs.
        prefix: config.queue.prefix,
        defaultJobOptions: {
          // Job payloads are small (ids and flags), but keeping every job forever turns
          // Redis into an unbounded log. Retention is long enough to debug a failure the
          // next morning and no longer.
          removeOnComplete: { age: 86_400, count: 1000 },
          removeOnFail: { age: 7 * 86_400, count: 1000 },
        },
      }),
    }),
    ...MANAGED_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  controllers: [JobsController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueuesModule {}
