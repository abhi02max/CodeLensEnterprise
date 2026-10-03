import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@codelens/shared';
import type { Job } from 'bullmq';
import { CollaborationExecutionService } from '../../collaboration/collaboration-execution.service';
import { AppConfigService } from '../../config/app-config.service';
import type { CollaborationJobData } from '../queue.types';
import { BaseQueueProcessor } from './base.processor';

@Processor(QUEUE_NAMES.COLLABORATION, { autorun: false, lockDuration: 120000 })
export class CollaborationProcessor extends BaseQueueProcessor<CollaborationJobData> {
  protected readonly queueName = QUEUE_NAMES.COLLABORATION;
  protected readonly logger = new Logger(CollaborationProcessor.name);
  constructor(
    config: AppConfigService,
    private readonly collaboration: CollaborationExecutionService,
  ) {
    super(config);
  }
  async process(job: Job<CollaborationJobData>) {
    try {
      return await this.collaboration.execute(job.data);
    } catch {
      throw new Error(
        'Collaboration worker could not finalize execution; poll turn for recovery state.',
      );
    }
  }
  protected override concurrency() {
    return 2;
  }
}
