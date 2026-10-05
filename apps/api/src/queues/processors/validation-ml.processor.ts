import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ValidationMlService } from '../../collaboration/validation-ml.service';
import { VALIDATION_ML_QUEUE, ValidationMlJobSchema } from '../validation-ml.queue';
import { isWorkerProcess } from '../worker-mode';
@Processor(VALIDATION_ML_QUEUE, { autorun: false, lockDuration: 420000 })
export class ValidationMlProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ValidationMlProcessor.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly ml: ValidationMlService) {
    super();
  }
  onApplicationBootstrap() {
    if (!isWorkerProcess()) return;
    this.worker.concurrency = 1;
    void this.worker.run().catch(() => this.logger.error('ML assessment worker stopped'));
    void this.reconcile();
  }
  private async reconcile() {
    if (this.stopped) return;
    try {
      await this.ml.reconcile();
    } catch {
      this.logger.warn('ML assessment reconciliation unavailable');
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.reconcile(), 1000);
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async process(job: Job) {
    try {
      await this.ml.execute(ValidationMlJobSchema.parse(job.data).comparisonId);
    } catch {
      throw new Error('ML assessment execution unavailable; database readback is authoritative.');
    }
  }
}
