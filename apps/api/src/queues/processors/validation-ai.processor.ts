import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ValidationAiService } from '../../collaboration/validation-ai.service';
import { VALIDATION_AI_QUEUE, ValidationAiJobSchema } from '../validation-ai.queue';
import { isWorkerProcess } from '../worker-mode';
@Processor(VALIDATION_AI_QUEUE, { autorun: false, lockDuration: 90000 })
export class ValidationAiProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ValidationAiProcessor.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly ai: ValidationAiService) {
    super();
  }
  onApplicationBootstrap() {
    if (!isWorkerProcess()) return;
    this.worker.concurrency = 1;
    void this.worker.run().catch(() => this.logger.error('AI re-review worker stopped'));
    void this.reconcile();
  }
  private async reconcile() {
    if (this.stopped) return;
    try {
      await this.ai.reconcile();
    } catch {
      this.logger.warn('AI re-review reconciliation unavailable');
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.reconcile(), 1000);
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async process(job: Job) {
    try {
      await this.ai.execute(ValidationAiJobSchema.parse(job.data).reviewId);
    } catch {
      throw new Error('AI re-review unavailable; database readback is authoritative.');
    }
  }
}
