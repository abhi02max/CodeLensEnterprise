import { cn } from '@/lib/cn';
import type { RiskLevel, Severity } from '@/lib/types';

/**
 * Risk and severity are the only things in the UI allowed to use colour.
 *
 * Colour is also never the sole carrier: every badge states its level in text. A reviewer with a
 * red/green deficiency, or anyone scanning a dense list, reads the word — the colour only speeds
 * up someone who already knows the scale.
 */

const RISK_STYLES: Record<RiskLevel, string> = {
  LOW: 'border-green-200 bg-green-50 text-risk-low',
  MEDIUM: 'border-amber-200 bg-amber-50 text-risk-medium',
  HIGH: 'border-orange-200 bg-orange-50 text-risk-high',
  CRITICAL: 'border-red-200 bg-red-50 text-risk-critical',
};

export function RiskBadge({
  level,
  score,
  className,
}: {
  level: RiskLevel;
  score?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs font-semibold',
        RISK_STYLES[level],
        className,
      )}
    >
      {level}
      {score !== undefined && <span className="numeric font-normal opacity-80">{score}</span>}
    </span>
  );
}

/**
 * Risk score as a compact bar.
 *
 * Not a chart library: one div. A 0–100 score with a threshold is the entire information content,
 * and pulling in a charting dependency to draw a rectangle would be the wrong trade.
 */
export function RiskMeter({ score, level }: { score: number; level: RiskLevel }) {
  const fill: Record<RiskLevel, string> = {
    LOW: 'bg-risk-low',
    MEDIUM: 'bg-risk-medium',
    HIGH: 'bg-risk-high',
    CRITICAL: 'bg-risk-critical',
  };

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
      role="meter"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Risk score ${score} of 100, ${level}`}
    >
      <div
        className={cn('h-full rounded-full transition-all', fill[level])}
        style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
      />
    </div>
  );
}

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: 'border-red-200 bg-red-50 text-risk-critical',
  HIGH: 'border-orange-200 bg-orange-50 text-risk-high',
  MEDIUM: 'border-amber-200 bg-amber-50 text-risk-medium',
  LOW: 'border-slate-200 bg-surface-muted text-slate-600',
  INFO: 'border-slate-200 bg-surface-muted text-slate-500',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide',
        SEVERITY_STYLES[severity],
      )}
    >
      {severity}
    </span>
  );
}

export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Run status, using the same restraint: text first, colour as a hint. */
export function RunStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'COMPLETED'
      ? 'border-green-200 bg-green-50 text-green-800'
      : status === 'PARTIAL'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : status === 'FAILED'
          ? 'border-red-200 bg-red-50 text-red-800'
          : status === 'RUNNING'
            ? 'border-sky-200 bg-sky-50 text-sky-800'
            : 'border-surface-border bg-surface-muted text-slate-600';

  return (
    <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium', tone)}>
      {status}
    </span>
  );
}
