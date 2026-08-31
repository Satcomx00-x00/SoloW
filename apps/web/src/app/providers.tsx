"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink } from "@trpc/client";
import type { ReactNode } from "react";
import { useState } from "react";
import superjson from "superjson";
import { trpc } from "@/trpc/react";
import { createQueryClient } from "./query-client";

/**
 * Client-side tRPC + React Query providers for the SPA.
 *
 * **Streaming, not plain batching.** `httpBatchLink` holds a whole batch open until its slowest
 * procedure finishes, then answers all of them at once — so a screen whose four reads are
 * batched together paints at the speed of the worst one, and three answers that were ready sit
 * in a buffer waiting for the fourth. `httpBatchStreamLink` sends the same single request and
 * releases each result the moment it resolves, so the fast reads paint while the slow one is
 * still running. The batching, and its saving on round trips, is unchanged; only the waiting
 * goes.
 *
 * Both the client and the query cache are built once per mount and held in state, never rebuilt
 * on render: a new `QueryClient` on a re-render would throw away everything already fetched,
 * which is the opposite of what `createQueryClient`'s policy is for.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchStreamLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
