'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { HealthBanner } from '@/components/health-banner';
import { Badge, Button, Spinner } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/providers';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/repositories', label: 'Repositories' },
  { href: '/pull-requests', label: 'Pull requests' },
  { href: '/activity', label: 'Activity' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, user, organizations, activeOrganizationId, role, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          {status === 'loading' ? 'Restoring session' : 'Redirecting to sign in'}
        </div>
      </div>
    );
  }

  const activeOrg = organizations.find((org) => org.id === activeOrganizationId);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-white">
        <div className="flex h-11 items-center gap-4 px-4">
          <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-900 text-[0.625rem] font-bold text-white">
              CL
            </span>
            <span className="hidden text-sm font-semibold tracking-tight text-slate-900 sm:inline">
              CodeLens
            </span>
          </Link>

          {/* Horizontal nav rather than a sidebar: four destinations do not justify spending
              200px of a review screen's width permanently. */}
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'whitespace-nowrap rounded px-2 py-1 text-sm transition-colors',
                    active
                      ? 'bg-surface-muted font-medium text-slate-900'
                      : 'text-slate-600 hover:bg-surface-subtle hover:text-slate-900',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            {activeOrg && (
              <div className="hidden items-center gap-1.5 md:flex">
                <span className="text-xs text-slate-500">{activeOrg.name}</span>
                <Badge tone="outline">{role}</Badge>
              </div>
            )}
            <span className="hidden text-xs text-slate-500 lg:inline">{user?.email}</span>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
        <HealthBanner />
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4">{children}</main>
    </div>
  );
}
