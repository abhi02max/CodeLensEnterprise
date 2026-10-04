import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PatchApplicationService } from '../../collaboration/patch-application.service';
import {
  PATCH_APPLICATION_QUEUE,
  PatchApplicationJobSchema,
  type PatchApplicationJob,
} from '../patch-application.queue';
import { isWorkerProcess } from '../worker-mode';

@Processor(PATCH_APPLICATION_QUEUE, { autorun: false, lockDuration: 180000 })
export class PatchApplicationProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PatchApplicationProcessor.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly applications: PatchApplicationService) {
    super();
  }
  onApplicationBootstrap() {
    // The API never receives sandbox authority, including when other API workers are enabled.
    if (!isWorkerProcess()) return;
    this.worker.concurrency = 1;
    void this.worker.run().catch(() => this.logger.error('Patch application worker stopped'));
    void this.reconcile();
  }
  private async reconcile() {
    if (this.stopped) return;
    try {
      await this.applications.reconcile();
    } catch {
      this.logger.warn('Patch application reconciliation unavailable');
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.reconcile(), 1000);
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async process(job: Job<PatchApplicationJob>) {
    try {
      await this.applications.execute(PatchApplicationJobSchema.parse(job.data));
    } catch {
      throw new Error(
        'Patch application execution unavailable; database readback is authoritative.',
      );
    }
  }
}
