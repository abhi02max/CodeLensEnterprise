/**
 * Whether this process is a dedicated worker.
 *
 * A module-level flag rather than configuration, because of an ordering problem that is easy
 * to get wrong and hard to notice.
 *
 * `worker.ts` originally signalled its intent by assigning `process.env.RUN_WORKERS_IN_API`
 * before creating the application context. That assignment never took effect:
 * `ConfigModule.forRoot()` is evaluated while `app.module.ts` is being imported, which
 * happens before any statement in `bootstrap()` runs, and it validates and caches the
 * configuration at that moment. So a deployment following the documented production layout —
 * `RUN_WORKERS_IN_API=false` in the shared environment, plus a separate `pnpm worker`
 * process — ended up with a worker that connected, reported itself ready, and consumed
 * nothing. Verified against a live queue: two jobs sat waiting while the worker logged
 * "registered but not started".
 *
 * This flag is set before the context is created and read at application bootstrap, so it is
 * immune to that ordering. It is deliberately one-way: a process may declare itself a worker,
 * never the reverse, so nothing can accidentally disable a worker that was asked for.
 */
let forced = false;

/** Declare this process a dedicated worker. Call before creating the Nest context. */
export function runAsWorkerProcess(): void {
  forced = true;
}

export function isWorkerProcess(): boolean {
  return forced;
}
