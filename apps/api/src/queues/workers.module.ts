import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { RagModule } from '../rag/rag.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { PrSyncProcessor } from './processors/pr-sync.processor';
import { RepoIndexProcessor } from './processors/repo-index.processor';
import { ReviewRunProcessor } from './processors/review-run.processor';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { CollaborationProcessor } from './processors/collaboration.processor';
import { PatchApplicationProcessor } from './processors/patch-application.processor';
import { ValidationProcessor } from './processors/validation.processor';
import { ValidationMlProcessor } from './processors/validation-ml.processor';
import { ValidationAiProcessor } from './processors/validation-ai.processor';

/**
 * Consumer half of the queue layer.
 *
 * Imported by both entrypoints: `main.ts` (where the workers run only if
 * `RUN_WORKERS_IN_API` is true) and `worker.ts` (where they always do). The processors are
 * declared with `autorun: false`, so registering this module is not the same as starting a
 * worker — {@link BaseQueueProcessor} makes that decision at bootstrap.
 *
 * Importing it unconditionally in both places means the worker and the API share exactly one
 * definition of how a job is executed. A separate worker wiring is how the two drift.
 */
@Module({
  imports: [AnalysisModule, RagModule, RepositoriesModule, CollaborationModule],
  providers: [
    ReviewRunProcessor,
    RepoIndexProcessor,
    PrSyncProcessor,
    CollaborationProcessor,
    PatchApplicationProcessor,
    ValidationProcessor,
    ValidationMlProcessor,
    ValidationAiProcessor,
  ],
})
export class WorkersModule {}
