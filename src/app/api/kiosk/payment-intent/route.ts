import { NextResponse } from "next/server";

import { resolveKioskAccount } from "@/lib/kiosk/resolve";
import {
  STRIPE_META,
  computeApplicationFeeCents,
  getStripeClient,
} from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe Terminal PaymentIntent for the PrimeKiosk tablet. Supabase-native
 * replacement for the Xano `payment-intent_v2` endpoint. Creates the intent as a
 * DIRECT charge on the kiosk's connected account with the platform application
 * fee, exactly like Xano (card_present, automatic capture). The charge records
 * itself into stripe_transactions (source='kiosk') via the Stripe webhook, so
 * there is nothing to write here.
 *
 * Body: { kiosk, amount, application_fee_amount?, booking_id?, idempotency_key? }
 *   amount / application_fee_amount are integer cents.
 * Response mirrors Xano: { payment_intent (= client_secret), id, account, amount,
 *   application_fee_amount }.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  kiosk?: string;
  amount?: number;
  application_fee_amount?: number;
  booking_id?: string;
  idempotency_key?: string;
};

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
  const amount = Math.floor(Number(body.amount) || 0);
  if (!kiosk) {
    return NextResponse.json({ error: "missing_kiosk" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "bad_amount" }, { status: 400 });
  }

  const resolved = await resolveKioskAccount(admin, kiosk);
  if (!resolved) {
    return NextResponse.json({ error: "unknown_kiosk" }, { status: 404 });
  }

  // Platform fee: honor an explicit override, otherwise the global rate. Both are
  // clamped below the amount (Stripe rejects a fee >= the charge).
  const override = Math.floor(Number(body.application_fee_amount) || 0);
  const fee =
    override > 0
      ? Math.min(override, amount - 1)
      : computeApplicationFeeCents(amount);

  const bookingRef = String(body.booking_id ?? "").trim();
  const metadata: Record<string, string> = {
    [STRIPE_META.source]: "kiosk",
    kiosk,
    app_fee: String(fee),
  };
  if (bookingRef) metadata[STRIPE_META.bookingId] = bookingRef;
  if (resolved.businessId) metadata[STRIPE_META.businessId] = resolved.businessId;

  // Stable per-sale key so retries never double-charge (Xano falls back to
  // booking_id when no explicit key is sent).
  const idempotencyKey =
    String(body.idempotency_key ?? "").trim() || bookingRef || undefined;

  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        metadata,
      },
      {
        stripeAccount: resolved.account,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    );
    return NextResponse.json({
      payment_intent: pi.client_secret,
      id: pi.id,
      account: resolved.account,
      amount,
      application_fee_amount: fee,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stripe_error";
    return NextResponse.json({ error: "stripe_error", message }, { status: 502 });
  }
}
