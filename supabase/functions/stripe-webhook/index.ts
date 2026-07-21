// Stripe webhook, Supabase-native (Deno) port of the Vercel /api/stripe/webhook route.
// One endpoint handles both the platform's own events and Connect events forwarded from
// connected accounts. Register the endpoint(s) in Stripe pointing here; each has its own
// signing secret (platform + connected). Signature verification uses the Stripe SDK's
// ASYNC verifier (constructEventAsync + SubtleCryptoProvider) because Deno has no Node
// crypto. Idempotency is enforced via the stripe_events table. All writes use the service
// role (there is no user session on a webhook, and the ledger tables have no write RLS).
//
// Deployed with JWT off: Stripe does not send a Supabase token; the Stripe signature is the
// auth. Secrets: STRIPE_SECRET_KEY (platform key), STRIPE_WEBHOOK_SECRET,
// STRIPE_WEBHOOK_SECRET_CONNECTED. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are provided.
//
// This file is the source of truth for the deployed `stripe-webhook` function. Keep the
// ledger row shape in sync with src/app/api/stripe/webhook/route.ts.

import Stripe from "npm:stripe@22.3.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const WEBHOOK_SECRETS = [
  Deno.env.get("STRIPE_WEBHOOK_SECRET"),
  Deno.env.get("STRIPE_WEBHOOK_SECRET_CONNECTED"),
].filter((s): s is string => Boolean(s));

// Metadata keys written on every charge (mirrors src/lib/stripe/server.ts STRIPE_META).
const META = { bookingId: "booking_id", source: "source", businessId: "business_id" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!STRIPE_SECRET_KEY || WEBHOOK_SECRETS.length === 0) {
    return json({ error: "not_configured" }, 503);
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return json({ error: "missing_signature" }, 400);

  // Raw body is required for signature verification.
  const body = await req.text();

  // Try each secret (platform vs connected); accept the first that verifies.
  let event: Stripe.Event | null = null;
  for (const secret of WEBHOOK_SECRETS) {
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, secret, undefined, cryptoProvider);
      break;
    } catch {
      // try the next secret
    }
  }
  if (!event) return json({ error: "invalid_signature" }, 400);

  // Idempotency: if already fully processed, ack and stop.
  const { data: existing } = await sb
    .from("stripe_events")
    .select("id, processed_at")
    .eq("id", event.id)
    .maybeSingle();
  if (existing?.processed_at) return json({ received: true, duplicate: true }, 200);
  if (!existing) {
    await sb.from("stripe_events").insert({
      id: event.id,
      type: event.type,
      account: event.account ?? null,
      livemode: event.livemode,
      payload: event as unknown as Record<string, unknown>,
    });
  }

  try {
    await handleEvent(event);
    await sb.from("stripe_events").update({ processed_at: new Date().toISOString(), error: null }).eq("id", event.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "handler_error";
    await sb.from("stripe_events").update({ error: message }).eq("id", event.id);
    // 500 tells Stripe to retry with backoff.
    return json({ error: "handler_error" }, 500);
  }

  return json({ received: true }, 200);
});

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === "paid") {
        await markBookingPaid(
          session.metadata?.[META.bookingId] ?? null,
          typeof session.payment_intent === "string" ? session.payment_intent : null,
        );
      }
      return;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await markBookingPaid(pi.metadata?.[META.bookingId] ?? null, pi.id);
      return;
    }
    case "charge.succeeded":
    case "charge.updated":
    case "charge.refunded": {
      await upsertChargeToLedger(event, event.data.object as Stripe.Charge);
      return;
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
      await sb
        .from("stripe_transactions")
        .update({ dispute_status: dispute.status, status: "disputed" })
        .eq("stripe_id", chargeId);
      return;
    }
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      await sb
        .from("businesses")
        .update({
          stripe_charges_enabled: Boolean(account.charges_enabled),
          stripe_payouts_enabled: Boolean(account.payouts_enabled),
          stripe_details_submitted: Boolean(account.details_submitted),
          stripe_requirements_due: account.requirements?.currently_due?.length ?? 0,
          stripe_account_synced_at: new Date().toISOString(),
        })
        .eq("stripe_account_id", account.id);
      return;
    }
    default:
      // Unhandled event types are acknowledged (recorded in stripe_events).
      return;
  }
}

/** Flip a pending booking to confirmed + paid. No-op if the id is not a booking. */
async function markBookingPaid(bookingId: string | null, paymentIntentId: string | null): Promise<void> {
  if (!bookingId || !UUID_RE.test(bookingId)) return;
  const patch: Record<string, unknown> = { status: "confirmed", paid_at: new Date().toISOString() };
  if (paymentIntentId) patch.stripe_payment_intent_id = paymentIntentId;
  await sb.from("bookings").update(patch).eq("id", bookingId);
}

/** Upsert one Stripe Charge into the ledger, keyed on the charge id. */
async function upsertChargeToLedger(event: Stripe.Event, charge: Stripe.Charge): Promise<void> {
  const dest =
    typeof charge.transfer_data?.destination === "string"
      ? charge.transfer_data.destination
      : (charge.transfer_data?.destination?.id ?? null);
  const connectedAccountId = event.account ?? dest ?? null;
  const chargeType = event.account ? "direct" : dest ? "destination" : null;

  // Net + Stripe fee live on the balance transaction (on the connected account for a direct
  // charge). Retrieve when it is only a reference.
  let stripeFee = 0;
  let net = 0;
  const bt = charge.balance_transaction;
  if (bt && typeof bt === "object") {
    stripeFee = bt.fee ?? 0;
    net = bt.net ?? 0;
  } else if (typeof bt === "string") {
    try {
      const balance = await stripe.balanceTransactions.retrieve(
        bt,
        undefined,
        event.account ? { stripeAccount: event.account } : undefined,
      );
      stripeFee = balance.fee ?? 0;
      net = balance.net ?? 0;
    } catch {
      // leave fee/net at 0 if not retrievable
    }
  }

  const bookingRef = charge.metadata?.[META.bookingId] ?? null;
  const businessId = connectedAccountId ? await businessIdForAccount(connectedAccountId) : null;
  const pm = charge.payment_method_details;

  const row = {
    stripe_id: charge.id,
    object_type: "charge",
    business_id: businessId,
    connected_account_id: connectedAccountId,
    charge_type: chargeType,
    amount: charge.amount ?? 0,
    currency: charge.currency ?? "usd",
    stripe_fee: stripeFee,
    application_fee: typeof charge.application_fee_amount === "number" ? charge.application_fee_amount : 0,
    net,
    amount_refunded: charge.amount_refunded ?? 0,
    card_country: pm?.card?.country ?? pm?.card_present?.country ?? null,
    card_brand: pm?.card?.brand ?? pm?.card_present?.brand ?? null,
    card_last4: pm?.card?.last4 ?? pm?.card_present?.last4 ?? pm?.interac_present?.last4 ?? null,
    status: charge.refunded ? "refunded" : (charge.status ?? null),
    on_behalf_of: typeof charge.on_behalf_of === "string" ? charge.on_behalf_of : (charge.on_behalf_of?.id ?? null),
    // Source priority: the kiosk tag the POS stamps (kiosk1..kiosk4) is the most
    // specific, then our own metadata (groupon/schedule), else the online widget.
    source: charge.metadata?.kiosk ?? charge.metadata?.[META.source] ?? "online",
    booking_id: bookingRef && UUID_RE.test(bookingRef) ? bookingRef : null,
    booking_ref: bookingRef,
    customer_email: charge.billing_details?.email ?? null,
    customer_name: charge.billing_details?.name ?? null,
    descriptor: charge.calculated_statement_descriptor ?? null,
    receipt_url: charge.receipt_url ?? null,
    livemode: charge.livemode,
    stripe_created: new Date(charge.created * 1000).toISOString(),
    raw: charge as unknown as Record<string, unknown>,
  };

  await sb.from("stripe_transactions").upsert(row, { onConflict: "stripe_id" });
}

async function businessIdForAccount(accountId: string): Promise<string | null> {
  const { data } = await sb.from("businesses").select("id").eq("stripe_account_id", accountId).maybeSingle();
  return data?.id ?? null;
}
