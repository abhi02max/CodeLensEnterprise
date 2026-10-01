'use client';

import { useRouter } from 'next/navigation';
import { Github } from 'lucide-react';
import * as React from 'react';
import { Alert, Button, Input, Label } from '@/components/ui/primitives';
import { ApiError, API_URL } from '@/lib/api-client';
import { useSession } from '@/lib/providers';

export default function SignInPage() {
  const { signIn, status } = useSession();
  const router = useRouter();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<ApiError | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  /**
   * Gate submission on hydration.
   *
   * Sign-in is entirely client-side, so before React attaches its handler a click would trigger
   * the browser's *native* form submission. Found in a browser pass: that navigated to
   * `/signin?email=…&password=…`, putting the password in the URL, in history, and in any access
   * log along the way. It happened because a stale build had left the JS chunks 404ing, which is
   * exactly the class of failure this has to survive — a slow network or a bad deploy produces the
   * same window.
   *
   * Two defences, because either alone is incomplete: the button is inert until the handler
   * exists, and the fields carry no `name` so a native submit has nothing to serialise.
   */
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  // Someone landing here with a live session should not have to sign in again.
  React.useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email.trim(), password);
      router.replace('/dashboard');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, 'UNKNOWN', 'Sign-in failed for an unexpected reason.'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-slate-900 text-xs font-bold text-white">
              CL
            </span>
            <span className="text-lg font-semibold tracking-tight text-slate-900">
              CodeLens Enterprise
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Sign in to the review workspace.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          // POST, and no field names: if a native submit ever happens, there is nothing to put in
          // a query string. Autofill still works — browsers key on type and autocomplete, not name.
          method="post"
          className="rounded-lg border border-surface-border bg-white p-4"
        >
          <div className="space-y-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={Boolean(error?.fieldErrors?.email) || undefined}
                className="mt-1"
                placeholder="you@company.com"
              />
              {error?.fieldErrors?.email?.map((message) => (
                <p key={message} className="mt-1 text-xs text-red-700">
                  {message}
                </p>
              ))}
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(error?.fieldErrors?.password) || undefined}
                className="mt-1"
              />
              {error?.fieldErrors?.password?.map((message) => (
                <p key={message} className="mt-1 text-xs text-red-700">
                  {message}
                </p>
              ))}
            </div>
          </div>

          {error && (
            <Alert
              tone={error.code === 'NETWORK_ERROR' ? 'warning' : 'danger'}
              className="mt-3"
              title={error.code === 'NETWORK_ERROR' ? 'API unreachable' : 'Could not sign in'}
            >
              <p>{error.message}</p>
              {/*
                The trace id is shown rather than hidden. It is the only handle that connects what
                the user saw to the server log line, and asking someone to reproduce a failure is
                more expensive than printing sixteen characters.
              */}
              {error.traceId && (
                <p className="mt-1 font-mono text-[0.6875rem] opacity-70">
                  trace {error.traceId}
                </p>
              )}
            </Alert>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            disabled={!hydrated}
            className="mt-4 w-full"
          >
            {hydrated ? 'Sign in' : 'Loading…'}
          </Button>
        </form>

        <Button className="mt-3 w-full" disabled={!hydrated} onClick={() => window.location.assign(`${API_URL}/auth/github`)}>
          <Github className="h-4 w-4" aria-hidden="true" />
          Sign in with GitHub
        </Button>

        <p className="mt-3 text-center font-mono text-[0.6875rem] text-slate-400">
          API {API_URL}
        </p>
      </div>
    </main>
  );
}
