import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import {
  STATIC_BOUNDS,
  STATIC_IDENTITY,
  staticInputDigest,
  staticSourceBound,
  type StaticEdits,
  type StaticFile,
  type StaticResult,
} from './validation-static';

export async function runValidationStatic(
  sources: Record<'ORIGINAL' | 'PATCHED', StaticFile[]>,
  edits: StaticEdits,
  signal: AbortSignal,
): Promise<Record<'ORIGINAL' | 'PATCHED', StaticResult>> {
  const unavailable = (status: StaticResult['status'], reason: string) =>
    Object.fromEntries(
      (['ORIGINAL', 'PATCHED'] as const).map((side) => [
        side,
        {
          status,
          reason,
          identity: STATIC_IDENTITY,
          inputDigest: staticInputDigest(sources[side]),
          findings: [],
        },
      ]),
    ) as unknown as Record<'ORIGINAL' | 'PATCHED', StaticResult>;
  if (signal.aborted) throw new Error('STATIC_CANCELLED');
  const bound = staticSourceBound(sources.ORIGINAL) ?? staticSourceBound(sources.PATCHED);
  if (bound) return unavailable('UNSUPPORTED', bound);
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'validation-static-worker.js'), {
      workerData: { sources, edits },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (value: Record<'ORIGINAL' | 'PATCHED', StaticResult> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      void worker.terminate().then(
        () => (value ? resolve(value) : reject(new Error('STATIC_CANCELLED'))),
        () => reject(new Error('STATIC_WORKER_TERMINATION_FAILED')),
      );
    };
    const cancel = () => finish(null);
    const timer = setTimeout(
      () => finish(unavailable('TIMED_OUT', 'ANALYZER_TIME_BOUND')),
      STATIC_BOUNDS.durationMs,
    );
    signal.addEventListener('abort', cancel, { once: true });
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.once('message', (value) =>
      finish(value?.failed ? unavailable('FAILED', 'ANALYZER_FAILURE') : value),
    );
    worker.once('error', () => finish(unavailable('FAILED', 'ANALYZER_FAILURE')));
    worker.once('exit', () => {
      if (!settled) finish(unavailable('FAILED', 'ANALYZER_EXIT'));
    });
    if (signal.aborted) cancel();
  });
}
