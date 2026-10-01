import { Logger, type INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../config/app-config.service';
import { HealthService } from '../health/health.service';
import { ReviewRunProcessor } from './processors/review-run.processor';
import { RepoIndexProcessor } from './processors/repo-index.processor';
import { PrSyncProcessor } from './processors/pr-sync.processor';
import { createShutdown } from './shutdown';
import { MANAGED_QUEUES } from './queue.types';

export function installShutdown(app: INestApplicationContext): (signal: string) => void {
  const close = app.close.bind(app);
  const logger = new Logger('Shutdown');
  const shutdown = createShutdown({
    workers: () => [app.get(ReviewRunProcessor).worker, app.get(RepoIndexProcessor).worker,
      app.get(PrSyncProcessor).worker],
    closeQueues: async () => {
      await Promise.all(MANAGED_QUEUES.map((name) => app.get<Queue>(getQueueToken(name)).close()));
    },
    closeApplication: close,
    markDraining: () => app.get(HealthService).markDraining(),
    drainMs: app.get(AppConfigService).queue.shutdownDrainMs,
    logger,
  });
  const listeners = new Map<string, () => void>();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const listener = () => {
      void shutdown(signal).then(
        (clean) => process.exit(clean ? 0 : 1),
        () => { logger.error('Shutdown failed before cleanup'); process.exit(1); },
      );
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  app.close = async (signal?: string) => {
    const clean = await shutdown(signal);
    for (const [name, listener] of listeners) process.removeListener(name, listener);
    if (!clean) throw new Error('Application shutdown did not complete safely');
  };
  return (signal) => listeners.get(signal)?.();
}

export function captureBootstrapSignals(): {
  ready: (app: INestApplicationContext) => boolean;
} {
  let pending: string | undefined;
  const listeners = new Map<string, () => void>();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const listener = () => { pending ??= signal; };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  return {
    ready: (app) => {
      const requestShutdown = installShutdown(app);
      for (const [signal, listener] of listeners) process.removeListener(signal, listener);
      if (pending) requestShutdown(pending);
      return pending !== undefined;
    },
  };
}
