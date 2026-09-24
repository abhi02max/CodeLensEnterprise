'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * A small set of hand-written primitives in the shadcn/ui idiom.
 *
 * shadcn/ui was not already configured, and its CLI would pull in Radix packages this MVP does not
 * need — there are no menus, popovers or comboboxes in the demo flow. These give the same
 * `cva` variant ergonomics and the same visual language for a fraction of the dependency surface,
 * and the components are here to be edited rather than upgraded.
 */

// ---------------------------------------------------------------- button

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-slate-900 text-white hover:bg-slate-800',
        secondary: 'border border-surface-border bg-white text-slate-800 hover:bg-surface-muted',
        ghost: 'text-slate-600 hover:bg-surface-muted hover:text-slate-900',
        approve: 'bg-risk-low text-white hover:bg-green-800',
        reject: 'bg-risk-critical text-white hover:bg-red-800',
        danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-sm',
        lg: 'h-9 px-4 text-sm',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
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
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------- card

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-surface-border bg-white', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 border-b border-surface-border px-4 py-2.5',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-3', className)} {...props} />;
}

// ---------------------------------------------------------------- badge

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-surface-border bg-surface-muted text-slate-600',
        outline: 'border-surface-border bg-white text-slate-600',
        success: 'border-green-200 bg-green-50 text-green-800',
        warning: 'border-amber-200 bg-amber-50 text-amber-800',
        danger: 'border-red-200 bg-red-50 text-red-800',
        info: 'border-sky-200 bg-sky-50 text-sky-800',
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

// ---------------------------------------------------------------- form

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('block text-xs font-medium text-slate-700', className)}
      {...props}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-8 w-full rounded-md border border-surface-border bg-white px-2.5 text-sm text-slate-900 placeholder:text-slate-400',
          'disabled:cursor-not-allowed disabled:bg-surface-muted',
          'aria-[invalid=true]:border-red-400',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-surface-border bg-white px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400',
        className,
      )}
      {...props}
    />
  );
});

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8 rounded-md border border-surface-border bg-white px-2 text-sm text-slate-900',
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
    danger: 'border-red-200 bg-red-50 text-red-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-green-200 bg-green-50 text-green-900',
  } as const;

  return (
    <div
      // Assertive for errors so a screen reader announces a failed action immediately; polite for
      // the rest, which are contextual rather than interrupting.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-md border px-3 py-2 text-sm', tones[tone], className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-surface-muted', className)} />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-md text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
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
    <div className={cn('flex items-baseline justify-between gap-3 py-1', className)}>
      <dt className="shrink-0 text-xs text-slate-500">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs font-medium text-slate-800">{children}</dd>
    </div>
  );
}
