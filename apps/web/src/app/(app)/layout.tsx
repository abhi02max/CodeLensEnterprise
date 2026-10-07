'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { AppShell } from '@/components/app-shell';
import { LoadingRegion } from '@/components/ui/primitives';
import { useSession } from '@/lib/providers';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, user, organizations, activeOrganizationId, role, signOut } = useSession();
  const router = useRouter();
  React.useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);
  if (status !== 'authenticated')
    return (
      <LoadingRegion
        className="p-6"
        label={status === 'loading' ? 'Restoring session' : 'Redirecting to sign in'}
      />
    );
  return (
    <AppShell
      organization={organizations.find((org) => org.id === activeOrganizationId)?.name}
      name={user?.name}
      role={role}
      onSignOut={() => void signOut()}
    >
      {children}
    </AppShell>
  );
}
