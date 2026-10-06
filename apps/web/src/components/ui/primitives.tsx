'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Native controls with presentation tokens; callers retain domain/state ownership. */

// ---------------------------------------------------------------- button

const buttonVariants = cva(
  'inline-flex max-w-full items-center justify-center gap-1.5 whitespace-normal break-words rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-interactive text-content-inverse enabled:hover:bg-interactive-hover',
        secondary:
          'border border-structure-strong bg-surface text-content-secondary enabled:hover:bg-surface-muted',
        ghost:
          'text-content-muted enabled:hover:bg-surface-muted enabled:hover:text-content-primary',
        approve: 'bg-state-success-solid text-content-inverse enabled:hover:bg-state-success-hover',
        reject: 'bg-state-danger-solid text-content-inverse enabled:hover:bg-state-danger-hover',
        danger:
          'border border-state-danger-border bg-surface text-state-danger-text enabled:hover:bg-state-danger-bg',
      },
      size: {
        sm: 'min-h-7 px-2.5 py-1 text-metadata',
        md: 'min-h-8 px-control-x py-1 text-compact',
        lg: 'min-h-9 px-4 py-1.5 text-compact',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  density?: 'compact' | 'comfortable';
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  density,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        buttonVariants({ variant, size }),
        density === 'compact' && 'min-h-row-compact',
        density === 'comfortable' && 'min-h-row-comfortable',
        className,
      )}
      disabled={disabled || loading}
      // Announced to screen readers, not just shown as a spinner.
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner className="h-3 w-3" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      className={cn('h-4 w-4 shrink-0 animate-spin', className)}
      strokeWidth={2}
      aria-hidden="true"
      focusable="false"
    />
  );
}

// ---------------------------------------------------------------- card

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('min-w-0 rounded-frame border border-structure bg-surface', className)}
      {...props}
    />
  );
}

interface HeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ title, subtitle, actions, className }: HeaderProps) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 flex-1 basis-40">
        <h2 className="break-words text-panel font-semibold text-content-primary">{title}</h2>
        {subtitle && (
          <p className="mt-1 break-words text-metadata text-content-muted">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, className }: HeaderProps) {
  return (
    <header className={cn('flex min-w-0 flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 flex-1 basis-48">
        <h1 className="break-words text-page font-semibold text-content-primary">{title}</h1>
        {subtitle && <p className="mt-1 break-words text-body text-content-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardHeader({ title, subtitle, actions, className }: HeaderProps) {
  return (
    <SectionHeader
      title={title}
      subtitle={subtitle}
      actions={actions}
      className={cn('border-b border-structure-divider px-section-x py-section-y', className)}
    />
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-section-x py-section-y', className)} {...props} />;
}

// ---------------------------------------------------------------- badge

const badgeVariants = cva(
  'inline-flex max-w-full items-center gap-1 break-words rounded-control border px-1.5 py-0.5 text-metadata font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-structure bg-surface-muted text-content-muted',
        outline: 'border-structure bg-surface text-content-muted',
        success: 'border-state-success-border bg-state-success-bg text-state-success-text',
        warning: 'border-state-warning-border bg-state-warning-bg text-state-warning-text',
        danger: 'border-state-danger-border bg-state-danger-bg text-state-danger-text',
        info: 'border-state-info-border bg-state-info-bg text-state-info-text',
        unavailable:
          'border-state-unavailable-border bg-state-unavailable-bg text-state-unavailable-text',
        uncertain: 'border-state-uncertain-border bg-state-uncertain-bg text-state-uncertain-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export type StatusTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'unavailable'
  | 'uncertain';
const statusText: Record<StatusTone, string> = {
  neutral: 'text-content-muted',
  success: 'text-state-success-text',
  warning: 'text-state-warning-text',
  danger: 'text-state-danger-text',
  info: 'text-state-info-text',
  unavailable: 'text-state-unavailable-text',
  uncertain: 'text-state-uncertain-text',
};

export function StatusLabel({
  label,
  tone = 'neutral',
  context,
  className,
}: {
  label: string;
  tone?: StatusTone;
  context?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full flex-wrap items-baseline gap-x-1 text-metadata font-medium',
        statusText[tone],
        className,
      )}
    >
      <span className="break-words">{label}</span>
      {context && <span className="break-words font-normal text-content-muted">({context})</span>}
    </span>
  );
}

export function SeverityLabel({
  severity,
}: {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
}) {
  const tones = {
    CRITICAL: 'border-severity-critical-border bg-severity-critical-bg text-severity-critical-text',
    HIGH: 'border-severity-high-border bg-severity-high-bg text-severity-high-text',
    MEDIUM: 'border-severity-medium-border bg-severity-medium-bg text-severity-medium-text',
    LOW: 'border-severity-low-border bg-severity-low-bg text-severity-low-text',
    INFO: 'border-structure bg-surface-muted text-content-muted',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex rounded-control border px-1.5 py-0.5 text-metadata font-semibold',
        tones[severity],
      )}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------- form

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('block text-label font-medium text-content-secondary', className)}
      {...props}
    />
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'min-h-8 min-w-0 w-full rounded-control border border-structure-strong bg-surface px-control-x py-1 text-compact text-content-primary placeholder:text-content-muted',
        'disabled:cursor-not-allowed disabled:bg-surface-muted',
        'disabled:text-content-disabled aria-[invalid=true]:border-state-danger-solid',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-w-0 w-full rounded-control border border-structure-strong bg-surface px-control-x py-2 text-compact text-content-primary placeholder:text-content-muted',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-content-disabled aria-[invalid=true]:border-state-danger-solid',
        className,
      )}
      {...props}
    />
  );
});

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'min-h-8 min-w-0 max-w-full rounded-control border border-structure-strong bg-surface px-control-x py-1 text-compact text-content-primary',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-content-disabled aria-[invalid=true]:border-state-danger-solid',
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------- feedback

export function Alert({
  tone = 'danger',
  title,
  children,
  className,
}: {
  tone?: 'danger' | 'warning' | 'info' | 'success';
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    danger: 'border-state-danger-border bg-state-danger-bg text-state-danger-text',
    warning: 'border-state-warning-border bg-state-warning-bg text-state-warning-text',
    info: 'border-state-info-border bg-state-info-bg text-state-info-text',
    success: 'border-state-success-border bg-state-success-bg text-state-success-text',
  } as const;

  return (
    <div
      // Assertive for errors so a screen reader announces a failed action immediately; polite for
      // the rest, which are contextual rather than interrupting.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'min-w-0 break-words rounded-control border px-control-x py-2 text-body',
        tones[tone],
        className,
      )}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-pulse rounded-control bg-surface-muted', className)}
    />
  );
}

export function LoadingRegion({
  label,
  children,
  className,
}: {
  label: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div aria-busy="true" className={cn('min-w-0', className)}>
      <p role="status" className="flex items-center gap-2 text-compact text-content-muted">
        <Spinner />
        {label}
      </p>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 px-section-x py-8 text-center">
      <p className="max-w-full break-words text-panel font-medium text-content-secondary">
        {title}
      </p>
      {description && (
        <p className="max-w-md break-words text-compact text-content-muted">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-1 flex max-w-full flex-wrap justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/** Key/value row used throughout the workspace panels. */
export function Field({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1',
        className,
      )}
    >
      <dt className="min-w-0 break-words text-metadata text-content-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-metadata font-medium text-content-secondary">
        {children}
      </dd>
    </div>
  );
}
