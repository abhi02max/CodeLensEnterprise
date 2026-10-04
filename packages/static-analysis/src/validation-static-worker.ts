import { parentPort, workerData } from 'node:worker_threads';
import { analyzeStaticSource, compareStaticOccurrences } from './validation-static';

try {
  const { sources, edits } = workerData;
  parentPort!.postMessage(
    compareStaticOccurrences(
      analyzeStaticSource(sources.ORIGINAL, 'ORIGINAL', edits),
      analyzeStaticSource(sources.PATCHED, 'PATCHED', edits),
      edits,
    ),
  );
} catch {
  // Never serialize a source-bearing exception.
  parentPort!.postMessage({ failed: true });
}
