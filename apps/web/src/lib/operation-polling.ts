const ACTIVE = new Set(['QUEUED', 'PREPARING', 'APPLYING', 'RUNNING']);
const TERMINAL = new Set(['APPLIED', 'COMPLETED', 'FAILED', 'CANCELLED']);

/** An uncertain read is not a terminal failure; retain a slower recovery read. */
export function operationPollingInterval(
  items: ReadonlyArray<{ status?: string; state?: string; cleanup: string }> | undefined,
  readFailed = false,
): number | false {
  if (readFailed || !items) return 10_000;
  if (items.some((item) => ACTIVE.has(item.status ?? item.state ?? ''))) return 1000;
  if (
    items.some(
      (item) => item.cleanup === 'UNCERTAIN' || !TERMINAL.has(item.status ?? item.state ?? ''),
    )
  )
    return 10_000;
  return false;
}
