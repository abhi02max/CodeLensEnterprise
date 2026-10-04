import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { applicationRead } from '../collaboration/patch-application-deadline';

export const PATCH_APPLICATION_QUEUE = 'patch-application';
export const PatchApplicationJobSchema = z
  .object({
    organizationId: z.string().min(1).max(100),
    applicationId: z.string().min(1).max(100),
    attemptId: z.string().min(1).max(100),
  })
  .strict();
export type PatchApplicationJob = z.infer<typeof PatchApplicationJobSchema>;

@Injectable()
export class PatchApplicationQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(@InjectQueue(PATCH_APPLICATION_QUEUE) private readonly queue: Queue) {}
  async enqueue(jobId: string, data: PatchApplicationJob) {
    // Retention is deliberate: removing a completed job would make an enqueue replay executable.
    let operation = this.pending.get(jobId);
    if (!operation) {
      if (this.pending.size >= 50) throw new Error('APPLICATION_QUEUE_BUSY');
      operation = this.queue.add('materialize', PatchApplicationJobSchema.parse(data), {
        jobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });
      this.pending.set(jobId, operation);
      const settled = () => this.pending.delete(jobId);
      void operation.then(settled, settled);
    }
    await applicationRead(operation, new AbortController().signal, 2000);
  }
}
