'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api } from './api';
import { ApiError, bootstrapSession, setAccessToken, setUnauthenticatedHandler } from './api-client';
import type { OrganizationSummary, PublicUser, Role } from './types';

interface SessionState {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: PublicUser | null;
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  role: Role | null;
}

interface SessionContextValue extends SessionState {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <Providers>');
  return context;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A review workspace is read repeatedly while someone works through it, so a short stale
        // window avoids refetching the whole payload on every panel interaction without showing
        // data old enough to mislead.
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Never retry a rejected request: 401 is handled by the refresh path in api-client, and
          // 403/404/422 will fail identically on a second attempt.
          if (error instanceof ApiError && error.status > 0 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(makeQueryClient);
  const router = useRouter();

  const [state, setState] = React.useState<SessionState>({
    status: 'loading',
    user: null,
    organizations: [],
    activeOrganizationId: null,
    role: null,
  });

  const applySession = React.useCallback(
    (session: {
      user: PublicUser;
      organizations: OrganizationSummary[];
      activeOrganizationId: string | null;
    }) => {
      const active =
        session.organizations.find((org) => org.id === session.activeOrganizationId) ??
        session.organizations[0] ??
        null;

      setState({
        status: 'authenticated',
        user: session.user,
        organizations: session.organizations,
        activeOrganizationId: active?.id ?? null,
        // Role comes from the membership rather than being re-derived: the API's own guards read
        // it from the token, and showing a different one would make the UI disagree with what the
        // server will actually allow.
        role: active?.role ?? null,
      });
    },
    [],
  );

  /**
   * Recover the session on load.
   *
   * The access token is in memory only, so a reload always starts without one. The refresh cookie
   * is httpOnly and same-site, so this exchanges it for a fresh token before any query runs —
   * which is why the shell renders a loading state rather than briefly flashing the sign-in page.
   */
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      const recovered = await bootstrapSession();

      if (!recovered) {
        if (!cancelled) setState((prev) => ({ ...prev, status: 'anonymous' }));
        return;
      }

      try {
        const session = await api.session();
        if (!cancelled) applySession(session);
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, status: 'anonymous' }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySession]);

  // A refresh that fails mid-session means the refresh token is gone too, so drop everything
  // cached for the old identity before routing to sign-in.
  React.useEffect(() => {
    setUnauthenticatedHandler(() => {
      setState({
        status: 'anonymous',
        user: null,
        organizations: [],
        activeOrganizationId: null,
        role: null,
      });
      queryClient.clear();
      router.replace('/signin');
    });

    return () => setUnauthenticatedHandler(null);
  }, [queryClient, router]);

  const signIn = React.useCallback(
    async (email: string, password: string) => {
      const response = await api.signIn(email, password);
      applySession(response);
    },
    [applySession],
  );

  const signOut = React.useCallback(async () => {
    await api.signOut();
    setAccessToken(null);
    setState({
      status: 'anonymous',
      user: null,
      organizations: [],
      activeOrganizationId: null,
      role: null,
    });
    queryClient.clear();
    router.replace('/signin');
  }, [queryClient, router]);

  const value = React.useMemo<SessionContextValue>(
    () => ({ ...state, signIn, signOut }),
    [state, signIn, signOut],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </QueryClientProvider>
  );
}
