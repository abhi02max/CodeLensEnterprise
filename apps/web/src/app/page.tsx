'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { LoadingRegion } from '@/components/ui/primitives';
import { useSession } from '@/lib/providers';

/**
 * No landing page. The root resolves the session and sends the user to the first useful screen.
 *
 * A marketing page here would sit between an engineer and the thing they opened the tab to do.
 */
export default function RootPage() {
  const { status } = useSession();
  const router = useRouter();

  React.useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  return (
    <main className="flex h-full items-center justify-center">
      <LoadingRegion label="Loading CodeLens" />
    </main>
  );
}
