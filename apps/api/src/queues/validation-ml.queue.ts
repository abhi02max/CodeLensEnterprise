import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { applicationRead } from '../collaboration/patch-application-deadline';
export const VALIDATION_ML_QUEUE = 'validation-ml-assessment';
export const ValidationMlJobSchema = z.object({ comparisonId: z.string().uuid() }).strict();
@Injectable()
export class ValidationMlQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(@InjectQueue(VALIDATION_ML_QUEUE) private readonly queue: Queue) {}
  async enqueue(comparisonId: string) {
    const data = ValidationMlJobSchema.parse({ comparisonId });
    let operation = this.pending.get(comparisonId);
    if (!operation) {
      if (this.pending.size >= 50) throw new Error('ML_QUEUE_BUSY');
      operation = this.queue.add('risk-pair', data, {
        jobId: 'validation-ml-' + comparisonId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });
      this.pending.set(comparisonId, operation);
      const settled = () => this.pending.delete(comparisonId);
      void operation.then(settled, settled);
    }
    await applicationRead(operation, new AbortController().signal, 2000);
  }
}
