import { readFrame, encodeFrame, MATERIALIZATION_LIMITS } from '@codelens/patch-core';
import { executeMaterialization } from './materialize';

// A fixed entry point; errors never serialize source, requests, or exceptions.
const deadline = setTimeout(() => process.exit(124), MATERIALIZATION_LIMITS.deadlineMs);
void (async () => {
  try {
    const request = await readFrame(process.stdin, MATERIALIZATION_LIMITS.inputBytes);
    const result = await executeMaterialization(request, '/workspace');
    process.stdout.write(
      encodeFrame(
        { version: 1, status: 'MATERIALIZED', result },
        MATERIALIZATION_LIMITS.outputBytes,
      ),
    );
  } catch {
    process.stdout.write(
      encodeFrame({ version: 1, status: 'REJECTED' }, MATERIALIZATION_LIMITS.outputBytes),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
})();
