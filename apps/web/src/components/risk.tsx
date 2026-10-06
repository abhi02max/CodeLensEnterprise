import * as React from 'react';
import { cn } from '@/lib/cn';
import type { RiskLevel, Severity } from '@/lib/types';
import { SeverityLabel, StatusLabel, type StatusTone } from './ui/primitives';

/**
 * Colour is also never the sole carrier: every badge states its level in text. A reviewer with a
 * red/green deficiency, or anyone scanning a dense list, reads the word — the colour only speeds
 * up someone who already knows the scale.
 */

const RISK_STYLES: Record<RiskLevel, string> = {
  LOW: 'border-state-success-border bg-state-success-bg text-risk-low',
  MEDIUM: 'border-severity-medium-border bg-severity-medium-bg text-risk-medium',
  HIGH: 'border-severity-high-border bg-severity-high-bg text-risk-high',
  CRITICAL: 'border-severity-critical-border bg-severity-critical-bg text-risk-critical',
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
        'inline-flex max-w-full items-center gap-1.5 rounded-control border px-1.5 py-0.5 text-metadata font-semibold',
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

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <SeverityLabel severity={severity} />;
}

export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Run status, using the same restraint: text first, colour as a hint. */
export function RunStatusBadge({ status }: { status: string }) {
  const tones: Record<string, StatusTone> = {
    COMPLETED: 'info',
    RUNNING: 'info',
    PARTIAL: 'warning',
    FAILED: 'danger',
    UNAVAILABLE: 'unavailable',
    UNCERTAIN: 'uncertain',
  };
  return <StatusLabel label={status} tone={tones[status] ?? 'neutral'} />;
}
