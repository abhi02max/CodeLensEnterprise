import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { LIMITS, RunnerReportSchema } from './contracts';
export async function collectReport(root = '/output') {
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.()
  )
    throw new Error('REPORT_ROOT_REJECTED');
  const entries = await readdir(root);
  if (entries.length !== 1 || entries[0] !== 'report.json')
    throw new Error('REPORT_FILES_REJECTED');
  const handle = await open(
    root + '/report.json',
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await handle.stat();
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      st.size > LIMITS.reportBytes
    )
      throw new Error('REPORT_FILE_REJECTED');
    const buffer = Buffer.alloc(LIMITS.reportBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMITS.reportBytes) throw new Error('REPORT_BOUND');
    const after = await handle.stat();
    if (
      st.size !== after.size ||
      st.mtimeMs !== after.mtimeMs ||
      st.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1
    )
      throw new Error('REPORT_CHANGED');
    const raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Record<
      string,
      unknown
    >;
    if (raw['version'] === 1) return RunnerReportSchema.parse(raw);
    // Vitest JSON is reduced to bounded counts; names/messages are intentionally not exported.
    return RunnerReportSchema.parse({
      version: 1,
      kind: 'tests',
      passed: raw['numPassedTests'],
      failed: raw['numFailedTests'],
      total: raw['numTotalTests'],
    });
  } finally {
    await handle.close();
  }
}
