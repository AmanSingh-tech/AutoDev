'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { useState, type ReactNode } from 'react';
import superjson from 'superjson';
import { getCurrentOrgId, trpc } from '@/lib/trpc';

/** The API says the GitHub token is gone (revoked or expired): send the user to sign in again. */
function onError(err: unknown) {
  if (err instanceof TRPCClientError && err.message === 'GITHUB_REAUTH_REQUIRED') {
    window.location.href = `/login?reauth=1&callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError }),
        mutationCache: new MutationCache({ onError }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (count, err) =>
              !(err instanceof TRPCClientError && [401, 403, 404].includes(err.data?.httpStatus)) && count < 2,
          },
        },
      }),
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          transformer: superjson,
          headers: () => {
            const orgId = getCurrentOrgId();
            return orgId ? { 'x-org-id': orgId } : {};
          },
        }),
      ],
    }),
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
