import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ValidationService } from '../../collaboration/validation.service';
import { VALIDATION_QUEUE, ValidationJobSchema, type ValidationJob } from '../validation.queue';
import { isWorkerProcess } from '../worker-mode';

@Processor(VALIDATION_QUEUE, { autorun: false, lockDuration: 780000 })
export class ValidationProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ValidationProcessor.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly validation: ValidationService) {
    super();
  }
  onApplicationBootstrap() {
    if (!isWorkerProcess()) return;
    this.worker.concurrency = 1;
    void this.worker.run().catch(() => this.logger.error('Validation worker stopped'));
    void this.reconcile();
  }
  private async reconcile() {
    if (this.stopped) return;
    try {
      await this.validation.reconcile();
    } catch {
      this.logger.warn('Validation reconciliation unavailable');
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.reconcile(), 1000);
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async process(job: Job<ValidationJob>) {
    try {
      await this.validation.execute(ValidationJobSchema.parse(job.data));
    } catch {
      throw new Error('Validation execution unavailable; database readback is authoritative.');
    }
  }
}
