'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderGit2, History, ListChecks, LogOut, Menu, X } from 'lucide-react';
import * as React from 'react';
import { HealthBanner } from './health-banner';
import { Alert, Button } from './ui/primitives';
import { cn } from '@/lib/cn';
import { isDestinationActive, primaryDestinations, REVIEWS_HOME } from '@/lib/review-inbox';
import type { Role } from '@/lib/types';

export function SignOutButton({ onSignOut }: { onSignOut: () => void | Promise<void> }) {
  const inFlight = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  async function handleSignOut() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onSignOut();
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <div className="min-w-0">
      <Button variant="ghost" size="sm" loading={pending} onClick={() => void handleSignOut()}>
        <LogOut className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{pending ? 'Signing out' : 'Sign out'}</span>
        <span className="sr-only sm:hidden">{pending ? 'Signing out' : 'Sign out'}</span>
      </Button>
      {failed && (
        <Alert className="my-2 max-w-xs" title="Sign-out not confirmed">
          Your session may still be active. Try signing out again.
        </Alert>
      )}
    </div>
  );
}

export function PrimaryNav({
  pathname,
  role,
  onNavigate,
}: {
  pathname: string;
  role: Role | null;
  onNavigate?: () => void;
}) {
  const icons = { Reviews: ListChecks, Repositories: FolderGit2, History };
  return (
    <nav aria-label="Primary" className="space-y-1">
      {primaryDestinations(role).map((item) => {
        const Icon = icons[item.label as keyof typeof icons];
        const active = isDestinationActive(item.href, pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-row-comfortable items-center gap-2 rounded-control px-3 py-2 text-compact',
              active
                ? 'bg-selected font-semibold text-selected-text'
                : 'text-content-secondary hover:bg-surface-muted',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({
  children,
  organization,
  name,
  role,
  onSignOut,
}: {
  children: React.ReactNode;
  organization?: string;
  name?: string;
  role: Role | null;
  onSignOut: () => void | Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const toggle = React.useRef<HTMLButtonElement>(null);
  const disclosure = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);
  React.useEffect(() => {
    if (open) disclosure.current?.querySelector<HTMLAnchorElement>('a')?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <div
      className="flex min-h-screen flex-col bg-canvas text-content-primary"
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-structure bg-surface">
        <div className="flex min-h-12 items-center gap-3 px-4">
          <button
            ref={toggle}
            type="button"
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
            aria-controls="mobile-navigation"
            title={open ? 'Close navigation' : 'Open navigation'}
            onClick={() => (open ? close() : setOpen(true))}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control hover:bg-surface-muted md:hidden"
          >
            {open ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <Link href={REVIEWS_HOME} className="text-panel font-semibold">
            CodeLens
          </Link>
          <span className="hidden h-4 border-l border-structure sm:block" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words text-metadata text-content-muted">
            {organization}
          </span>
          <span className="hidden max-w-48 break-words text-metadata text-content-muted lg:block">
            {name}
          </span>
          <SignOutButton onSignOut={onSignOut} />
        </div>
        <HealthBanner />
        <div
          id="mobile-navigation"
          ref={disclosure}
          hidden={!open}
          className="border-t border-structure px-4 py-3 md:hidden"
        >
          <PrimaryNav pathname={pathname} role={role} onNavigate={() => setOpen(false)} />
        </div>
      </header>
      <div className="flex min-w-0 flex-1">
        <aside className="hidden w-36 shrink-0 self-stretch border-r border-structure bg-surface-subtle p-2 md:block xl:w-44">
          <div className="sticky top-16">
            <PrimaryNav pathname={pathname} role={role} />
          </div>
        </aside>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
