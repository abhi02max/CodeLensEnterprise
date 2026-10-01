import type { Logger } from '@nestjs/common';

interface DrainWorker {
  pause(): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export function createShutdown(options: {
  workers: () => DrainWorker[];
  closeQueues: () => Promise<void>;
  closeApplication: (signal?: string) => Promise<void>;
  markDraining: () => void;
  drainMs: number;
  cleanupMs?: number;
  logger: Pick<Logger, 'log' | 'error'>;
}): (signal?: string) => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  async function bounded(operation: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function run(signal?: string): Promise<boolean> {
    try {
      options.markDraining();
      options.logger.log(`Shutdown DRAINING signal=${signal ?? 'close'} budget_ms=${options.drainMs}`);
      const workers = options.workers();
      // Worker-local pause stops subsequent acquisition once BullMQ sets its paused flag,
      // while keeping lock renewal/dependencies alive
      // while active work finishes. Do not start close(false): it cannot be upgraded
      // to close(true) once its unbounded drain is already in progress.
      const drained = await bounded(Promise.all(workers.map((worker) => worker.pause())), options.drainMs);
      if (drained) options.logger.log('Shutdown active work drained');
      else options.logger.error('Shutdown drain expired or failed; forcing worker close; unfinished jobs require stalled recovery');
      const cleanupDeadline = Date.now() + (options.cleanupMs ?? 10_000);
      const remaining = () => Math.max(1, cleanupDeadline - Date.now());
      const workersClosed = await bounded(
        Promise.all(workers.map((worker) => worker.close(!drained))), remaining());
      if (!drained) {
        // close(true) does not stop a processor already executing. Keep its dependencies
        // available until the signal handler exits this process; never call app.close here.
        if (!workersClosed) options.logger.error('Shutdown forced worker close expired or failed');
        options.logger.log('Shutdown EXIT drained=false cleaned=false');
        return false;
      }
      const queuesClosed = await bounded(Promise.resolve().then(options.closeQueues), remaining());
      const dependenciesClosed = await bounded(
        Promise.resolve().then(() => options.closeApplication(signal)), remaining());
      const cleaned = workersClosed && queuesClosed && dependenciesClosed;
      if (!cleaned) options.logger.error('Shutdown cleanup expired or failed');
      options.logger.log(`Shutdown EXIT drained=${drained} cleaned=${cleaned}`);
      return drained && cleaned;
    } catch (error) {
      options.logger.error(`Shutdown failed before safe dependency teardown: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  return (signal) => {
    if (pending) return pending;
    // Starting immediately minimizes the signal-to-local-pause acquisition window.
    pending = run(signal);
    return pending;
  };
}
