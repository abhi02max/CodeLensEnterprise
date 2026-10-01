import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queues/queue.service';
import { RedisService } from '../redis/redis.service';

export interface DependencyHealth {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
  /** False when the product still functions without this dependency. */
  required: boolean;
}

export interface OverallHealth {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptimeSeconds: number;
  checks: DependencyHealth[];
}

/**
 * Health checks.
 *
 * The distinction that makes this useful in practice is `required`. Postgres being
 * down means the API cannot serve anything, so the status is `down` and an
 * orchestrator should pull the instance out of rotation. The ML service being down
 * means reviews lose their risk score but still produce static analysis and an AI
 * review, so the status is `degraded` and the instance should stay in rotation.
 *
 * Collapsing both into a single boolean would cause an ML outage to take down the
 * entire product, which is precisely the failure mode the pipeline was designed to
 * avoid.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();
  private draining = false;

  markDraining(): void { this.draining = true; }

  private drainingHealth(): OverallHealth {
    return { status: 'down', version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks: [{ name: 'shutdown', ok: false, latencyMs: 0, required: true, detail: 'Draining' }],
    };
  }

  /**
   * How long a job may sit unclaimed before the queues are reported unhealthy.
   *
   * Two minutes is comfortably longer than the worst legitimate wait — a worker busy with a
   * long analysis at the configured concurrency — and far shorter than the time it takes a
   * user to notice that an analysis never started.
   */
  private static readonly MAX_QUEUE_WAIT_MS = 120_000;
  private static readonly PROBE_TIMEOUT_MS = 5000;
  private readonly pendingProbes = new Map<string, Promise<DependencyHealth>>();

  private probe(
    name: string,
    required: boolean,
    operation: () => Promise<DependencyHealth>,
  ): Promise<DependencyHealth> {
    const pending = this.pendingProbes.get(name);
    if (pending) return pending;
    const raw = Promise.resolve().then(operation);
    const result = this.boundedProbe(name, required, () => raw);
    this.pendingProbes.set(name, result);
    // A timeout cannot cancel Prisma/BullMQ commands. Reuse the bounded result
    // until the original command settles, rather than accumulating outage probes.
    void raw.then(
      () => this.pendingProbes.delete(name),
      () => this.pendingProbes.delete(name),
    );
    return result;
  }

  private async boundedProbe(
    name: string,
    required: boolean,
    operation: () => Promise<DependencyHealth>,
  ): Promise<DependencyHealth> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<DependencyHealth>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Health probe timed out')),
            HealthService.PROBE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      return {
        name,
        required,
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly queues: QueueService,
  ) {}

  /**
   * Whether queued work is actually being consumed.
   *
   * This exists because of a specific, quiet failure mode: with no consumer attached, every
   * enqueue succeeds, every endpoint returns 202, and nothing ever runs. The only symptom is
   * analyses that stay queued forever, which reads as slowness rather than as an outage.
   *
   * Judged on how long the oldest waiting job has been waiting, not on the worker count.
   * BullMQ counts registered Redis connections as workers, so an API instance running with
   * RUN_WORKERS_IN_API=false still reports workers while consuming nothing — measured, not
   * assumed. Head-of-queue age has no such blind spot and also catches a wedged consumer and
   * a paused queue.
   *
   * Not `required`: an API instance that deliberately runs no workers is a valid deployment,
   * so a backlog degrades the service rather than pulling the instance out of rotation.
   */
  async queueHealth(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    const stats = await this.queues.stats();

    const broken = stats.filter((queue) => queue.error);
    const stalled = stats.filter(
      (queue) => (queue.oldestWaitingAgeMs ?? 0) > HealthService.MAX_QUEUE_WAIT_MS,
    );
    const pausedWithWork = stats.filter(
      (queue) => queue.paused && (queue.counts.waiting ?? 0) > 0,
    );

    const waiting = stats.reduce((sum, queue) => sum + (queue.counts.waiting ?? 0), 0);
    const active = stats.reduce((sum, queue) => sum + (queue.counts.active ?? 0), 0);

    const detail = broken.length
      ? `Could not read ${broken.map((queue) => queue.queue).join(', ')}: ${broken[0]?.error}`
      : stalled.length
        ? `Nothing is consuming ${stalled
            .map(
              (queue) =>
                `${queue.queue} (${queue.counts.waiting} waiting, oldest ` +
                `${Math.round((queue.oldestWaitingAgeMs ?? 0) / 1000)}s)`,
            )
            .join(', ')}. Start a worker process, or set RUN_WORKERS_IN_API=true.`
        : pausedWithWork.length
          ? `Paused with work waiting: ${pausedWithWork.map((queue) => queue.queue).join(', ')}`
          : `${waiting} waiting, ${active} active across ${stats.length} queue(s)`;

    return {
      name: 'queues',
      ok: broken.length === 0 && stalled.length === 0 && pausedWithWork.length === 0,
      latencyMs: Date.now() - startedAt,
      required: false,
      detail,
    };
  }

  async database(): Promise<DependencyHealth> {
    return this.probe('postgres', true, async () => {
      const result = await this.prisma.isHealthy();

      return {
        name: 'postgres',
        ok: result.ok,
        latencyMs: result.latencyMs,
        required: true,
        ...(result.error ? { detail: result.error } : {}),
      };
    });
  }

  async redisHealth(): Promise<DependencyHealth> {
    return this.probe('redis', true, async () => {
      const result = await this.redis.isHealthy();

      return {
        name: 'redis',
        ok: result.ok,
        latencyMs: result.latencyMs,
        // Required: BullMQ needs it, so without Redis no analysis can be enqueued.
        required: true,
        ...(result.error ? { detail: result.error } : {}),
      };
    });
  }

  /**
   * ML service reachability.
   *
   * Reports `ok: false` with the reason rather than throwing, and is marked
   * optional. A `degraded` ML status maps to reviews without a risk score.
   */
  async mlHealth(): Promise<DependencyHealth & { modelsLoaded: boolean }> {
    const startedAt = Date.now();
    const url = `${this.config.ml.url}/health`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.config.ml.timeoutMs, 5000));

      try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
          return {
            name: 'ml-service',
            ok: false,
            latencyMs: Date.now() - startedAt,
            required: false,
            modelsLoaded: false,
            detail: `HTTP ${response.status} from ${url}`,
          };
        }

        const body = (await response.json()) as {
          status?: string;
          models_loaded?: boolean;
          feature_schema_version?: number;
          detail?: string | null;
        };

        return {
          name: 'ml-service',
          // "degraded" on the ML side means it booted without model artifacts,
          // which is a real problem even though the process is up.
          ok: body.status === 'ok' && body.models_loaded === true,
          latencyMs: Date.now() - startedAt,
          required: false,
          modelsLoaded: Boolean(body.models_loaded),
          detail:
            body.detail ??
            (body.models_loaded
              ? `feature schema v${body.feature_schema_version}`
              : 'ML service is up but no model artifacts are loaded'),
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        name: 'ml-service',
        ok: false,
        latencyMs: Date.now() - startedAt,
        required: false,
        modelsLoaded: false,
        detail:
          message.includes('abort') || message.includes('timeout')
            ? `Timed out contacting ${url}`
            : `Could not reach ${url}: ${message}`,
      };
    }
  }

  /** Whether an LLM provider is configured. Reachability is deliberately not asserted. */
  aiHealth(): DependencyHealth {
    const ai = this.config.ai;

    return {
      name: 'ai-provider',
      ok: ai.configured,
      latencyMs: 0,
      required: false,
      detail: ai.configured
        ? `${ai.provider} / ${ai.model} configured; provider reachability not checked`
        : `No API key configured for ${ai.provider}; AI review will be skipped`,
    };
  }

  async overall(): Promise<OverallHealth> {
    if (this.draining) return this.drainingHealth();
    const [database, redis, ml, queues] = await Promise.all([
      this.database(),
      this.redisHealth(),
      this.mlHealth(),
      this.probe('queues', false, () => this.queueHealth()),
    ]);
    if (this.draining) return this.drainingHealth();

    const checks: DependencyHealth[] = [database, redis, ml, queues, this.aiHealth()];

    const requiredDown = checks.some((check) => check.required && !check.ok);
    const optionalDown = checks.some((check) => !check.required && !check.ok);

    const status: OverallHealth['status'] = requiredDown
      ? 'down'
      : optionalDown
        ? 'degraded'
        : 'ok';

    if (requiredDown) {
      this.logger.error(
        `Health check failed: ${checks
          .filter((c) => c.required && !c.ok)
          .map((c) => `${c.name} (${c.detail ?? 'no detail'})`)
          .join(', ')}`,
      );
    }

    return {
      status,
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }
}
