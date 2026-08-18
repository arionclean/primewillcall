"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * The client-side data cache.
 *
 * This is what makes coming back to a screen feel instant. Server components
 * still render the first paint, but once a screen has been visited its rows
 * live here, so returning to it shows them immediately and refetches behind
 * you instead of leaving staff looking at a skeleton again.
 *
 * The defaults are set for an operations app, where being a moment out of date
 * is worse than making an extra request:
 *
 * - `staleTime` 30s: enough to make quick round-trips between screens free,
 *   short enough that nothing feels frozen. Screens that hold money or
 *   check-in state override it to 0 and revalidate on every mount.
 * - `gcTime` 5m: a cached screen survives a long detour, well past the 30s the
 *   Next Router Cache keeps its rendered payload.
 * - `refetchOnWindowFocus`: a desk tablet left open all morning catches up the
 *   moment someone touches it.
 * - `retry` 1: a real failure should surface quickly, not after four backoffs.
 *   RLS denials come back as empty results rather than errors anyway, so
 *   retrying them would only add delay.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  // useState, not a module-level client: on the server every request would
  // otherwise share one cache, and one user's rows could seed another's.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
