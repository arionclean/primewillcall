// Stripe webhook. This is THE handler: the equivalent Vercel route was deleted, so Stripe
// delivers here and nowhere else.
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
// ledger row shape in sync with the stripe_transactions table and src/lib/stripe/server.ts.

import Stripe from "npm:stripe@22.3.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { mirrorGrouponBooking } from "../_shared/gp-xano-mirror.ts";

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
        const bookingId = session.metadata?.[META.bookingId] ?? null;
        await markBookingPaid(
          bookingId,
          typeof session.payment_intent === "string" ? session.payment_intent : null,
        );
        await emailCheckoutReceipt(event, session, bookingId);
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
      const status = {
        stripe_charges_enabled: Boolean(account.charges_enabled),
        stripe_payouts_enabled: Boolean(account.payouts_enabled),
        stripe_details_submitted: Boolean(account.details_submitted),
        stripe_requirements_due: account.requirements?.currently_due?.length ?? 0,
        stripe_account_synced_at: new Date().toISOString(),
      };

      await sb.from("businesses").update(status).eq("stripe_account_id", account.id);

      // A business being moved to a new account has that account parked in
      // stripe_account_id_pending, taking nothing, until Stripe enables charges on
      // it. Stripe tells us the moment that happens, so promote it here instead of
      // asking someone to watch for it and press a button. Gated on charges_enabled,
      // so the business never points at an account that cannot take money. The old
      // id is kept: its balance still has to pay out, and refunds of charges it took
      // are routed by stripe_transactions.connected_account_id.
      if (account.charges_enabled) {
        const { data: moving } = await sb
          .from("businesses")
          .select("id, stripe_account_id, stripe_account_id_legacy")
          .eq("stripe_account_id_pending", account.id)
          .maybeSingle();
        if (moving) {
          const legacy = [...(moving.stripe_account_id_legacy ?? [])];
          if (moving.stripe_account_id && !legacy.includes(moving.stripe_account_id)) {
            legacy.push(moving.stripe_account_id);
          }
          await sb
            .from("businesses")
            .update({
              stripe_account_id: account.id,
              stripe_account_id_pending: null,
              stripe_account_id_legacy: legacy,
              stripe_fees_payer: account.controller?.fees?.payer ?? null,
              ...status,
            })
            .eq("id", moving.id);
          console.log(`[stripe-webhook] business ${moving.id} switched to ${account.id}`);
        }
      }
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
  // awaiting_payment is what hides an unpaid /gp booking from staff. The money has
  // landed, so the booking is real: clear it in the same write that confirms it.
  const patch: Record<string, unknown> = {
    status: "confirmed",
    paid_at: new Date().toISOString(),
    awaiting_payment: false,
  };
  if (paymentIntentId) patch.stripe_payment_intent_id = paymentIntentId;
  await sb.from("bookings").update(patch).eq("id", bookingId);

  // Only now, once the confirmation trigger has already fired on the pending -> confirmed
  // update above. Stamping legacy_id any earlier marks the booking as Xano-synced and the
  // trigger skips it, which is how mirroring at creation silenced the guest's own text.
  await mirrorGrouponBooking(sb, bookingId);
}

/**
 * Email the Stripe receipt for a Checkout payment, and keep the address.
 *
 * Checkout collects the guest's email, but Stripe only sends a receipt by itself when
 * the account that took the charge has "Successful payments" emails switched on. These
 * are DIRECT charges, so that account is the business's connected account, and those
 * accounts have no Dashboard page to switch it on (Stripe hosts their dashboard; the
 * platform owns the settings). So the /gp success page promised "a receipt was emailed"
 * and none ever was: every Groupon charge in the ledger carried receipt_email = null.
 *
 * Setting receipt_email on the charge is the documented way to send one from the API
 * ("if this field is updated, then a new email receipt will be sent"), and it ignores
 * the account's email settings. Guarded on the charge not already carrying an address,
 * so a redelivered event cannot mail a second copy. Failures are logged, not thrown: a
 * retry would re-run markBookingPaid and move paid_at, and the payment already stands.
 *
 * The address also lands on the customer row when it has none. It is the only email a
 * /gp guest gives us, and "I never got a confirmation email" needs somewhere to reply.
 */
async function emailCheckoutReceipt(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  bookingId: string | null,
): Promise<void> {
  const email = session.customer_details?.email?.trim() || null;
  const piId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  if (!email || !piId) return;
  const opts = event.account ? { stripeAccount: event.account } : undefined;

  try {
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] }, opts);
    const charge = pi.latest_charge;
    if (charge && typeof charge !== "string" && !charge.receipt_email) {
      await stripe.charges.update(charge.id, { receipt_email: email }, opts);
    }
  } catch (err) {
    console.error(
      `[stripe-webhook] receipt for ${piId} not sent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!bookingId || !UUID_RE.test(bookingId)) return;
  const { data: booking } = await sb.from("bookings").select("customer_id").eq("id", bookingId).maybeSingle();
  if (!booking?.customer_id) return;
  await sb.from("customers").update({ email }).eq("id", booking.customer_id).is("email", null);
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

  // Kiosk sales reference their Xano booking (KS-...), which syncs into
  // bookings.legacy_id. Card-present charges carry no cardholder name, so take
  // the booked customer's name (and the booking link) from the synced booking.
  let bookingId = bookingRef && UUID_RE.test(bookingRef) ? bookingRef : null;
  let customerName = charge.billing_details?.name ?? null;
  if (bookingRef && !bookingId) {
    const { data: legacyBooking } = await sb
      .from("bookings")
      .select("id, customer:customers(full_name)")
      .eq("legacy_id", bookingRef)
      .maybeSingle();
    if (legacyBooking) {
      bookingId = legacyBooking.id as string;
      const fullName = (legacyBooking as { customer?: { full_name?: string | null } | null })
        .customer?.full_name;
      customerName = customerName ?? (fullName ? fullName.trim() : null);
    }
  }

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
    booking_id: bookingId,
    booking_ref: bookingRef,
    customer_email: charge.billing_details?.email ?? null,
    customer_name: customerName,
    descriptor: charge.calculated_statement_descriptor ?? null,
    receipt_url: charge.receipt_url ?? null,
    livemode: charge.livemode,
    stripe_created: new Date(charge.created * 1000).toISOString(),
    raw: charge as unknown as Record<string, unknown>,
  };

  await sb.from("stripe_transactions").upsert(row, { onConflict: "stripe_id" });
}

/**
 * The business an event's connected account belongs to.
 *
 * The live account is tried first (unique index, the hot path). A business that
 * has switched to a fee-free account keeps taking events on the account it left:
 * a refund, a dispute or a delayed charge can land days after the switch. Those
 * fall back to `stripe_account_id_legacy`, so the row still gets a business_id
 * instead of settling as NULL, which RLS would hide from that business's manager.
 */
async function businessIdForAccount(accountId: string): Promise<string | null> {
  const { data } = await sb.from("businesses").select("id").eq("stripe_account_id", accountId).maybeSingle();
  if (data?.id) return data.id;

  const { data: retired } = await sb
    .from("businesses")
    .select("id")
    .contains("stripe_account_id_legacy", [accountId])
    .limit(1)
    .maybeSingle();
  return retired?.id ?? null;
}
