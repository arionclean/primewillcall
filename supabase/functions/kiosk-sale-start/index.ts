// Kiosk card flow v2, step 1: start a card sale BEFORE the card is read.
//
// The tablet has already collected the customer's name, the pax and the tour. It
// sends the whole sale here. We write a hidden pending booking (through the same
// ingest Xano's sync uses), create the PaymentIntent for it as a direct charge on
// the kiosk's connected account, and record a kiosk_sales row tying them together.
// Only then does the tablet ask the reader for the card.
//
// Three properties make a double charge impossible from this point on:
//
//  1. Idempotent on the sale reference. Calling again with the same KS code returns
//     the same intent (Stripe idempotency key = the code), never a second one. If that
//     intent already succeeded, the sale is completed and returned as paid.
//  2. A captured payment the tablet never acknowledged is attached, not re-charged.
//     If this kiosk has a sale under five minutes old whose intent succeeded but no
//     tablet ever showed the paid outcome (the tablet crashed), and the amount and
//     first name match, the new sale IS that sale: we return it paid, and the reader
//     is never asked for the card. Two different customers paying the same amount
//     seconds apart never match, because each of their sales gets acknowledged.
//  3. Money can never move before the sale exists. A failure anywhere in here leaves
//     at most a hidden pending booking, which the sweep expires.
//
// Body: { kiosk, ref, amount_cents, product?, customer?: { name, first, last, phone },
//         xano: <the booking record the tablet would have posted to Xano>, app_build?, device_id? }
// Response (pending): { ok, status: 'pending', ref, sale_id, booking_id, payment_intent (client_secret),
//         payment_intent_id, account, amount, application_fee_amount }
// Response (paid):    { ok, status: 'paid', ref, sale_id, booking_id, payment_qr, reused, already, ... }
//
// Secrets: STRIPE_SECRET_KEY, XANO_WEBHOOK_SECRET (pending booking through the sync),
// optional KIOSK_SHARED_SECRET, STRIPE_PLATFORM_FEE_BPS.

import {
  REUSE_WINDOW_MS,
  SALE_COLUMNS,
  ackSale,
  canReuseSale,
  completeSale,
  computeApplicationFeeCents,
  createPendingBooking,
  getSaleByRef,
  json,
  kioskAuthorized,
  logEvent,
  paidPayload,
  resolveKiosk,
  serviceClient,
  stripeConfigured,
  stripeCreatePaymentIntent,
  stripeRetrievePaymentIntent,
  type SaleRow,
} from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const REF_RE = /^KS-[A-Z0-9]{6,12}$/;

interface StartBody {
  kiosk?: string;
  ref?: string;
  amount_cents?: number;
  product?: string;
  customer?: { name?: string; first?: string; last?: string; phone?: string };
  xano?: Record<string, unknown>;
  app_build?: string;
  device_id?: string;
}

Deno.serve(withSentry("kiosk-sale-start", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);
  if (!stripeConfigured()) return json({ error: "not_configured" }, 503);

  let body: StartBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const slug = String(body.kiosk ?? "").trim();
  const ref = String(body.ref ?? "").trim().toUpperCase();
  const amount = Math.floor(Number(body.amount_cents) || 0);
  const xano = body.xano && typeof body.xano === "object" ? body.xano : null;
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  if (!REF_RE.test(ref)) return json({ error: "bad_ref" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "bad_amount" }, 400);
  if (!xano || typeof xano.date_time !== "string" || !String(xano.product ?? "").trim()) {
    return json({ error: "bad_booking" }, 400);
  }

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk, account } = resolved;
  if (!kiosk.business_id) return json({ error: "kiosk_without_business" }, 409);
  if (!account) return json({ error: "no_stripe_account" }, 409);

  const product = String(body.product ?? "").trim() || "ticket";
  const customerName =
    String(body.customer?.name ?? xano.customer_name ?? "").trim() || null;
  const meta = {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    appBuild: body.app_build ?? null,
    deviceId: body.device_id ?? null,
  };

  // 1. The same sale again: a retry after an error, or a tablet that came back.
  const existing = await getSaleByRef(sb, ref);
  if (existing) {
    if (existing.kiosk_id !== kiosk.id) return json({ error: "ref_conflict" }, 409);
    // A reference is one sale at one price. The app generates a fresh reference on every
    // Book tap, so a different amount here means a bug or a replay, never a real edit,
    // and the intent Stripe holds for this reference carries the OLD amount.
    if (existing.amount_cents !== amount) return json({ error: "amount_mismatch", ref }, 409);
    if (existing.status === "paid") {
      const acked = await ackSale(sb, existing);
      return json(paidPayload(acked, { already: true }), 200);
    }
    if (existing.status === "abandoned") return json({ error: "sale_abandoned", ref }, 409);
    if (existing.payment_intent_id && existing.stripe_account_id) {
      const r = await stripeRetrievePaymentIntent(existing.payment_intent_id, existing.stripe_account_id);
      if (!r.ok) return json({ error: "stripe_error", message: r.error }, 502);
      if (r.pi.status === "succeeded") {
        const { sale } = await completeSale(sb, existing, "tablet", r.pi);
        const acked = await ackSale(sb, sale);
        return json(paidPayload(acked, { already: true }), 200);
      }
      if (r.pi.status === "canceled") return json({ error: "intent_canceled", ref }, 409);
      await logEvent(sb, { ...meta, ref, event: "sale_resumed", payload: { pi_status: r.pi.status } });
      return json(
        {
          ok: true,
          status: "pending",
          ref,
          sale_id: existing.id,
          booking_id: existing.booking_id,
          payment_intent: r.pi.client_secret,
          payment_intent_id: r.pi.id,
          account: existing.stripe_account_id,
          amount: existing.amount_cents,
          resumed: true,
        },
        200,
      );
    }
    // Pending with no intent (Stripe failed last time): fall through and create it.
  }

  // 2. A captured payment this kiosk never acknowledged: attach, do not charge again.
  if (!existing) {
    const since = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
    const { data: candidates } = await sb
      .from("kiosk_sales")
      .select(SALE_COLUMNS)
      .eq("kiosk_id", kiosk.id)
      .eq("amount_cents", amount)
      .is("tablet_acked_at", null)
      .in("status", ["pending", "paid"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<SaleRow[]>();
    for (let candidate of candidates ?? []) {
      if (candidate.status === "pending") {
        if (!candidate.payment_intent_id || !candidate.stripe_account_id) continue;
        const r = await stripeRetrievePaymentIntent(candidate.payment_intent_id, candidate.stripe_account_id);
        if (!r.ok || r.pi.status !== "succeeded") continue;
        candidate = (await completeSale(sb, candidate, "reuse", r.pi)).sale;
      }
      if (canReuseSale(candidate, { amountCents: amount, customerName })) {
        const acked = await ackSale(sb, candidate);
        await logEvent(sb, {
          ...meta,
          ref: candidate.ref,
          event: "sale_reused",
          level: "warn",
          payload: { attempted_ref: ref, customer_name: customerName, amount },
        });
        return json(paidPayload(acked, { reused: true }), 200);
      }
    }
  }

  // 3. A new sale: the pending booking first, then the sale row, then the intent.
  let sale: SaleRow | null = existing;
  let bookingId = existing?.booking_id ?? null;
  if (!bookingId) {
    const b = await createPendingBooking(sb, { ref, amountCents: amount, xanoPayload: xano });
    if (!b.ok) {
      await logEvent(sb, { ...meta, ref, event: "sale_start_failed", level: "error", payload: { step: "booking", error: b.error } });
      return json({ error: "booking_failed", message: b.error }, 502);
    }
    bookingId = b.bookingId;
  }

  if (!sale) {
    const { data: inserted, error } = await sb
      .from("kiosk_sales")
      .insert({
        ref,
        kiosk_id: kiosk.id,
        kiosk_slug: kiosk.slug,
        business_id: kiosk.business_id,
        type: "card",
        amount_cents: amount,
        product,
        customer_name: customerName,
        status: "pending",
        stripe_account_id: account,
        booking_id: bookingId,
        xano_payload: xano,
        app_build: body.app_build ?? null,
        device_id: body.device_id ?? null,
      })
      .select(SALE_COLUMNS)
      .single<SaleRow>();
    if (error || !inserted) {
      // A parallel start with the same ref won the unique index: use its row.
      const again = await getSaleByRef(sb, ref);
      if (!again) return json({ error: "insert_failed", message: error?.message ?? null }, 500);
      sale = again;
    } else {
      sale = inserted;
    }
  }

  const fee = computeApplicationFeeCents(amount);
  const r = await stripeCreatePaymentIntent({
    account,
    amountCents: amount,
    feeCents: fee,
    metadata: {
      source: "kiosk",
      kiosk: kiosk.slug,
      app_fee: String(fee),
      booking_id: ref,
      business_id: kiosk.business_id,
      kiosk_flow: "v2",
      sale_id: sale.id,
    },
    idempotencyKey: ref,
  });
  if (!r.ok) {
    await logEvent(sb, { ...meta, ref, event: "sale_start_failed", level: "error", payload: { step: "intent", error: r.error } });
    return json({ error: "stripe_error", message: r.error }, 502);
  }

  await sb
    .from("kiosk_sales")
    .update({ payment_intent_id: r.pi.id, stripe_account_id: account, booking_id: bookingId })
    .eq("id", sale.id);
  await logEvent(sb, {
    ...meta,
    ref,
    event: "sale_started",
    payload: { amount, fee, payment_intent: r.pi.id, booking_id: bookingId, customer_name: customerName },
  });

  return json(
    {
      ok: true,
      status: "pending",
      ref,
      sale_id: sale.id,
      booking_id: bookingId,
      payment_intent: r.pi.client_secret,
      payment_intent_id: r.pi.id,
      account,
      amount,
      application_fee_amount: fee,
    },
    200,
  );
}));
