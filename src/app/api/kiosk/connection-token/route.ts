import { NextResponse } from "next/server";

import { resolveKioskAccount } from "@/lib/kiosk/resolve";
import { getStripeClient } from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe Terminal connection token for the PrimeKiosk tablet. Supabase-native
 * replacement for the Xano `connection-token_v6` endpoint; the tablet points
 * here once the migration flips. Public (no user session), like the Xano one,
 * but it resolves the connected account server-side from the kiosk tag so a
 * caller can never choose which account to charge.
 *
 * Body: { kiosk }  (kiosks.slug, the tablet's login username in the legacy app)
 * Response mirrors Xano: { secret, location, account, simulated }.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { kiosk?: string };

export async function POST(req: Request) {
  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kiosk = String(body.kiosk ?? "").trim();
  if (!kiosk) {
    return NextResponse.json({ error: "missing_kiosk" }, { status: 400 });
  }

  const resolved = await resolveKioskAccount(admin, kiosk);
  if (!resolved) {
    return NextResponse.json({ error: "unknown_kiosk" }, { status: 404 });
  }

  try {
    // Create the token ON the connected account. Location is not passed to the
    // create call (matching Xano); it is returned so the tablet can scope readers.
    const token = await stripe.terminal.connectionTokens.create(
      {},
      { stripeAccount: resolved.account },
    );
    return NextResponse.json({
      secret: token.secret,
      location: resolved.location,
      account: resolved.account,
      simulated: resolved.simulated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stripe_error";
    return NextResponse.json({ error: "stripe_error", message }, { status: 502 });
  }
}
