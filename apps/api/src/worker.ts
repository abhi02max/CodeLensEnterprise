import 'reflect-metadata';

import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { QueueService } from './queues/queue.service';
import { runAsWorkerProcess } from './queues/worker-mode';
import { captureBootstrapSignals } from './queues/application-shutdown';

const LOG_LEVELS: Record<string, LogLevel[]> = {
  trace: ['verbose', 'debug', 'log', 'warn', 'error'],
  debug: ['debug', 'log', 'warn', 'error'],
  info: ['log', 'warn', 'error'],
  warn: ['warn', 'error'],
  error: ['error'],
};

/**
 * Standalone worker process.
 *
 * Runs the same `AppModule` as the API with no HTTP listener. Sharing the module is the
 * point: the worker gets the identical Prisma client, policy cache, tool registry and
 * pipeline the API uses, so a queued run and a `sync: true` run cannot diverge. A
 * hand-rolled worker wiring is how "works when I click the button, fails overnight" bugs
 * get introduced.
 *
 * Deploy this alongside the API with `RUN_WORKERS_IN_API=false` on the API so a long
 * analysis cannot compete with request handling for the event loop.
 */
async function bootstrap(): Promise<void> {
  const bootstrapSignals = captureBootstrapSignals();
  // Declared before the context is created, and deliberately not via process.env: the
  // configuration was already validated and cached while app.module.ts was imported, so
  // mutating the environment here would have no effect. See queues/worker-mode.ts.
  runAsWorkerProcess();

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = new Logger('Worker');

  app.useLogger(LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info!);

  if (bootstrapSignals.ready(app)) return;

  const stats = await app.get(QueueService).stats();

  logger.log(
    `Worker ready. env=${config.nodeEnv} concurrency=${config.queue.concurrency} ` +
      `prefix=${config.queue.prefix} ml=${config.ml.url} ai_configured=${config.ai.configured} ` +
      `run_workers_in_api=${config.queue.runWorkersInApi} (ignored in this process)`,
  );

  for (const queue of stats) {
    logger.log(
      `queue ${queue.queue}: ${queue.counts.waiting ?? 0} waiting, ` +
        `${queue.counts.active ?? 0} active, ${queue.counts.failed ?? 0} failed` +
        (queue.error ? ` (${queue.error})` : ''),
    );
  }
}

void bootstrap().catch((error: unknown) => {
  console.error('\nFailed to start the CodeLens worker:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
