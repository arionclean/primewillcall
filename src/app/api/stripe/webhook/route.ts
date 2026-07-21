import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { STRIPE_META, getStripeClient } from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Stripe webhook. One endpoint handles both the platform's own events and Connect
 * events forwarded from connected accounts (register two endpoints in the Stripe
 * dashboard, one platform + one Connect, both pointing here; each has its own
 * signing secret). Signature verification uses the official SDK, so unlike the
 * legacy Xano handler it enforces the timestamp tolerance.
 *
 * Writes go through the service-role admin client (there is no user session on a
 * webhook, and the ledger tables have no INSERT/UPDATE RLS policies on purpose).
 * Idempotency is enforced via the stripe_events table.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
type TxnInsert = Database["public"]["Tables"]["stripe_transactions"]["Insert"];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  // The raw body is required for signature verification.
  const body = await req.text();

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_CONNECTED,
  ].filter((s): s is string => Boolean(s));
  if (secrets.length === 0) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  let event: Stripe.Event | null = null;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret);
      break;
    } catch {
      // Try the next secret (platform vs connected). If none match we reject.
    }
  }
  if (!event) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Idempotency: if we already fully processed this event, ack and stop.
  const { data: existing } = await admin
    .from("stripe_events")
    .select("id, processed_at")
    .eq("id", event.id)
    .maybeSingle();
  if (existing?.processed_at) {
    return NextResponse.json({ received: true, duplicate: true });
  }
  if (!existing) {
    await admin.from("stripe_events").insert({
      id: event.id,
      type: event.type,
      account: event.account ?? null,
      livemode: event.livemode,
      payload: event as unknown as Database["public"]["Tables"]["stripe_events"]["Insert"]["payload"],
    });
  }

  try {
    await handleEvent(stripe, admin, event);
    await admin
      .from("stripe_events")
      .update({ processed_at: new Date().toISOString(), error: null })
      .eq("id", event.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "handler_error";
    await admin.from("stripe_events").update({ error: message }).eq("id", event.id);
    // 500 tells Stripe to retry with backoff.
    return NextResponse.json({ error: "handler_error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(
  stripe: Stripe,
  admin: Admin,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === "paid") {
        await markBookingPaid(
          admin,
          session.metadata?.[STRIPE_META.bookingId] ?? null,
          typeof session.payment_intent === "string" ? session.payment_intent : null,
        );
      }
      return;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await markBookingPaid(
        admin,
        pi.metadata?.[STRIPE_META.bookingId] ?? null,
        pi.id,
      );
      return;
    }
    case "charge.succeeded":
    case "charge.updated":
    case "charge.refunded": {
      await upsertChargeToLedger(stripe, admin, event, event.data.object as Stripe.Charge);
      return;
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
      await admin
        .from("stripe_transactions")
        .update({ dispute_status: dispute.status, status: "disputed" })
        .eq("stripe_id", chargeId);
      return;
    }
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      await admin
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
async function markBookingPaid(
  admin: Admin,
  bookingId: string | null,
  paymentIntentId: string | null,
): Promise<void> {
  if (!bookingId || !UUID_RE.test(bookingId)) return;
  const patch: Database["public"]["Tables"]["bookings"]["Update"] = {
    status: "confirmed",
    paid_at: new Date().toISOString(),
  };
  if (paymentIntentId) patch.stripe_payment_intent_id = paymentIntentId;
  await admin.from("bookings").update(patch).eq("id", bookingId);
}

/** Upsert one Stripe Charge into the ledger, keyed on the charge id. */
async function upsertChargeToLedger(
  stripe: Stripe,
  admin: Admin,
  event: Stripe.Event,
  charge: Stripe.Charge,
): Promise<void> {
  const dest =
    typeof charge.transfer_data?.destination === "string"
      ? charge.transfer_data.destination
      : (charge.transfer_data?.destination?.id ?? null);
  const connectedAccountId = event.account ?? dest ?? null;
  const chargeType = event.account ? "direct" : dest ? "destination" : null;

  // Net + Stripe fee live on the balance transaction (on the connected account
  // for a direct charge). Retrieve when it is only a reference. Xano never
  // populated these; we do.
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
      // Leave fee/net at 0 if the balance transaction is not retrievable.
    }
  }

  const bookingRef = charge.metadata?.[STRIPE_META.bookingId] ?? null;
  const businessId = connectedAccountId
    ? await businessIdForAccount(admin, connectedAccountId)
    : null;

  const row: TxnInsert = {
    stripe_id: charge.id,
    object_type: "charge",
    business_id: businessId,
    connected_account_id: connectedAccountId,
    charge_type: chargeType,
    amount: charge.amount ?? 0,
    currency: charge.currency ?? "usd",
    stripe_fee: stripeFee,
    application_fee:
      typeof charge.application_fee_amount === "number"
        ? charge.application_fee_amount
        : 0,
    net,
    amount_refunded: charge.amount_refunded ?? 0,
    card_country:
      charge.payment_method_details?.card?.country ??
      charge.payment_method_details?.card_present?.country ??
      null,
    card_brand:
      charge.payment_method_details?.card?.brand ??
      charge.payment_method_details?.card_present?.brand ??
      null,
    card_last4:
      charge.payment_method_details?.card?.last4 ??
      charge.payment_method_details?.card_present?.last4 ??
      charge.payment_method_details?.interac_present?.last4 ??
      null,
    status: charge.refunded ? "refunded" : (charge.status ?? null),
    on_behalf_of:
      typeof charge.on_behalf_of === "string"
        ? charge.on_behalf_of
        : (charge.on_behalf_of?.id ?? null),
    // Source priority: the kiosk tag the POS stamps (kiosk1..kiosk4) is the
    // most specific, then our own metadata (groupon/schedule), else the
    // online widget.
    source:
      charge.metadata?.kiosk ??
      charge.metadata?.[STRIPE_META.source] ??
      "online",
    booking_id: bookingRef && UUID_RE.test(bookingRef) ? bookingRef : null,
    booking_ref: bookingRef,
    customer_email: charge.billing_details?.email ?? null,
    customer_name: charge.billing_details?.name ?? null,
    descriptor: charge.calculated_statement_descriptor ?? null,
    receipt_url: charge.receipt_url ?? null,
    livemode: charge.livemode,
    stripe_created: new Date(charge.created * 1000).toISOString(),
    raw: charge as unknown as TxnInsert["raw"],
  };

  await admin.from("stripe_transactions").upsert(row, { onConflict: "stripe_id" });
}

async function businessIdForAccount(
  admin: Admin,
  accountId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("businesses")
    .select("id")
    .eq("stripe_account_id", accountId)
    .maybeSingle();
  return data?.id ?? null;
}
