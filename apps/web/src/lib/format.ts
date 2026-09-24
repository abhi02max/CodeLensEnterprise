/** Relative time, for lists where the exact timestamp is noise. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toLocaleDateString();
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function minutes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 60) return `${Math.round(value)} min`;
  return `${(value / 60).toFixed(1)} h`;
}

export function cents(value: number | null | undefined): string {
  if (!value) return '$0.00';
  return `$${(value / 100).toFixed(2)}`;
}

/** Human-readable tool name: `run_static_analysis` becomes `Run static analysis`. */
export function toolLabel(tool: string): string {
  const spaced = tool.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}
