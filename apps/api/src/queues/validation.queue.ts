import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { applicationRead } from '../collaboration/patch-application-deadline';

export const VALIDATION_QUEUE = 'validation';
export const ValidationJobSchema = z
  .object({
    organizationId: z.string().min(1).max(100),
    validationId: z.string().uuid(),
    attemptId: z.string().uuid(),
  })
  .strict();
export type ValidationJob = z.infer<typeof ValidationJobSchema>;
@Injectable()
export class ValidationQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(@InjectQueue(VALIDATION_QUEUE) private readonly queue: Queue) {}
  async enqueue(jobId: string, raw: ValidationJob) {
    const data = ValidationJobSchema.parse(raw);
    let operation = this.pending.get(jobId);
    if (!operation) {
      if (this.pending.size >= 50) throw new Error('VALIDATION_QUEUE_BUSY');
      operation = this.queue.add('paired-validation', data, {
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
