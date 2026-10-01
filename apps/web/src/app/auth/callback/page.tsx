'use client';

import Link from 'next/link';
import { Github } from 'lucide-react';
import * as React from 'react';
import { Alert, Button } from '@/components/ui/primitives';
import { API_URL } from '@/lib/api-client';
import { useSession } from '@/lib/providers';

const FAILURES: Record<string, string> = {
  denied: 'GitHub authorization was declined. Nothing was connected.',
  invalid: 'This GitHub connection expired or does not belong to this browser. Start again.',
  failed: 'GitHub connection could not be completed. Please try again.',
};

export default function OAuthCallbackPage() {
  const { status, user } = useSession();
  const [outcome, setOutcome] = React.useState<string | null>(null);
  React.useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('oauth');
    setOutcome(value === 'connected' || value !== null && Object.hasOwn(FAILURES, value) ? value : 'invalid');
    window.history.replaceState(null, '', '/auth/callback');
  }, []);
  const failure = outcome ? FAILURES[outcome] : null;
  const connected = outcome === 'connected' && status === 'authenticated' && user?.githubConnected;
  return (
    <main className="mx-auto w-full max-w-md px-4 py-12">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">GitHub connection</h1>
      {!outcome || status === 'loading' ? <p role="status">Completing connection...</p> : connected ? (
        <>
          <Alert tone="success" title="GitHub connected">Your GitHub account is connected.</Alert>
          <Link className="mt-4 inline-block text-sm font-medium text-slate-900 underline" href="/repositories">Continue to repositories</Link>
        </>
      ) : (
        <>
          <Alert tone="warning" title="GitHub not connected">{failure ?? 'Your session could not be recovered. Sign in and try again.'}</Alert>
          <Button className="mt-4" onClick={() => window.location.assign(`${API_URL}/auth/github${status === 'authenticated' ? '?mode=link' : ''}`)}><Github className="h-4 w-4" aria-hidden="true" />Try GitHub again</Button>
          <Link className="ml-4 text-sm underline" href="/signin">Back to sign in</Link>
        </>
      )}
    </main>
  );
}
