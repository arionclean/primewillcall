import { FunctionRegion } from "@supabase/supabase-js";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Result<T> = { data: T | null; error: string | null };

/**
 * Call an edge function as the signed-in staff member.
 *
 * `body` may be JSON or a FormData (a file upload). The answer comes back as
 * parsed JSON, or as a Blob when the function sends a file. On a non-2xx the
 * SDK's error carries the raw Response as `context`, so the function's own
 * message is read from there.
 *
 * `region` pins where the function runs. Only pass it to a function whose
 * preflight allows the `x-region` header (`_shared/browser-cors.ts`), or the
 * browser blocks the call.
 */
export async function invokeEdgeFunction<T>(
  name: string,
  body: Record<string, unknown> | FormData,
  region?: FunctionRegion,
): Promise<Result<T>> {
  const { data, error } = await getSupabaseBrowserClient().functions.invoke<T>(name, {
    body,
    ...(region ? { region } : {}),
  });
  if (!error) return { data: data ?? null, error: null };
  const response = (error as { context?: Response }).context;
  const payload = (await response?.json?.().catch(() => null)) as { error?: string } | null;
  return { data: null, error: payload?.error ?? "The server could not be reached. Try again." };
}

/** The edge functions behind the owner's Stripe screens (Payouts, Disputes). */
export type StripeFunction = "stripe-reports" | "stripe-disputes";

/**
 * Call one of the Stripe screens' functions, pinned to us-west-2, next to the
 * database: they match Stripe's records to our ledger, and from the default
 * (nearest-to-the-browser) region each lookup crossed the country, which made
 * opening a payout about a second slower.
 */
export function invokeStripeFunction<T>(
  name: StripeFunction,
  body: Record<string, unknown> | FormData,
): Promise<Result<T>> {
  return invokeEdgeFunction<T>(name, body, FunctionRegion.UsWest2);
}
