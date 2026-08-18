/**
 * Shared plumbing for the public /gp (Groupon voucher redemption) edge functions.
 *
 * The /gp page has no login, so these run with the service role and re-derive
 * everything from the database. They are deployed with JWT ON: the browser sends
 * the publishable anon key, which is a small gate the old Vercel routes did not
 * have (they were open to anyone who knew the path).
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Service-role client: the guest has no session, and /gp reads across businesses. */
export const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/** The /gp page is served from the Next app, so it is a cross-origin caller here. */
export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

/** Platform fee (cents): global rate, floored, clamped below the amount. */
export function computeApplicationFeeCents(amountCents: number): number {
  const bps = Number(Deno.env.get("STRIPE_PLATFORM_FEE_BPS") ?? "25");
  const rate = Number.isFinite(bps) ? bps : 25;
  if (!Number.isFinite(amountCents) || amountCents <= 0 || rate <= 0) return 0;
  const fee = Math.floor((amountCents * rate) / 10000);
  return Math.max(0, Math.min(fee, amountCents - 1));
}

/** Absolute app base URL (no trailing slash) for Stripe redirect URLs. */
export function appBaseUrl(): string {
  return (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
}

/** Metadata keys written on every charge (mirrors _shared/stripe meta in the webhook). */
export const STRIPE_META = {
  bookingId: "booking_id",
  source: "source",
  businessId: "business_id",
} as const;
