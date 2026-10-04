import { sanitizeDiagnosticText } from '@codelens/shared';
import { hash, LIMITS, RunnerReportSchema } from '@codelens/validation-executor';
const MARKER = '\x1eCODELENS_RUNNER_V1:';
export function sanitizeOutput(text: string, secrets: readonly string[] = []) {
  let safe = sanitizeDiagnosticText(
    text
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''),
    secrets,
  ).slice(0, LIMITS.excerptBytes);
  while (Buffer.byteLength(safe) > LIMITS.excerptBytes) safe = safe.slice(0, -1);
  return safe;
}
export function outputFact(bytes: Buffer, complete: boolean, secrets: readonly string[] = []) {
  return {
    digest: hash(bytes),
    capturedBytes: bytes.length,
    complete,
    excerpt: sanitizeOutput(bytes.toString('utf8'), secrets),
  };
}
export function runnerReported(bytes: Buffer, kind?: 'tests' | 'typecheck') {
  const reports = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.startsWith(MARKER));
  if (reports.length === 0)
    return {
      trusted: false as const,
      status: 'MISSING' as const,
      report: null,
      reportDigest: null,
    };
  if (reports.length !== 1 || Buffer.byteLength(reports[0]!) > LIMITS.reportBytes)
    return {
      trusted: false as const,
      status: 'REJECTED' as const,
      report: null,
      reportDigest: null,
    };
  const raw = reports[0]!.slice(MARKER.length);
  try {
    const report = RunnerReportSchema.parse(JSON.parse(raw));
    if (kind && report.kind !== kind) throw new Error('REPORT_KIND_REJECTED');
    return { trusted: false as const, status: 'VALID' as const, report, reportDigest: hash(raw) };
  } catch {
    return {
      trusted: false as const,
      status: 'REJECTED' as const,
      report: null,
      reportDigest: hash(raw),
    };
  }
}
