import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { applicationRead } from '../collaboration/patch-application-deadline';
export const VALIDATION_AI_QUEUE = 'validation-ai-rereview';
export const ValidationAiJobSchema = z.object({ reviewId: z.string().uuid() }).strict();
@Injectable()
export class ValidationAiQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(@InjectQueue(VALIDATION_AI_QUEUE) private readonly queue: Queue) {}
  async enqueue(reviewId: string) {
    const data = ValidationAiJobSchema.parse({ reviewId });
    let operation = this.pending.get(reviewId);
    if (!operation) {
      if (this.pending.size >= 50) throw new Error('AI_QUEUE_BUSY');
      operation = this.queue.add('rereview', data, {
        jobId: 'validation-ai-' + reviewId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });
      this.pending.set(reviewId, operation);
      const settled = () => this.pending.delete(reviewId);
      void operation.then(settled, settled);
    }
    await applicationRead(operation, new AbortController().signal, 2000);
  }
}
