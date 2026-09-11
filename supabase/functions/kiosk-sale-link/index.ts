// Kiosk card flow v2, the QR backup: the guest pays on their own phone.
//
// For when the reader is dead, flat, or missing and the desk has no spare. The sale
// is written first exactly as a reader sale is, then instead of asking a reader for
// the card we open a Stripe-hosted Checkout page and hand the tablet its URL. The
// tablet shows that URL as a QR code, the guest scans it and pays, and the tablet
// polls kiosk-sale-complete until Stripe says the money moved. Staff confirm nothing.
//
// Everything after the payment is the reader flow untouched: the same guarded
// completion, the same booking, cash_sales row and Xano mirror, the same sweep for a
// tablet that died. The only difference is who collected the card.
//
// It is card-not-present, so it costs more per sale and carries no chip liability
// shift. That is why it is a backup, not a payment method staff pick for fun.
//
// Body: { kiosk, ref, amount_cents, product?, customer?: { name }, xano: <booking record>,
//         app_build?, device_id?, employee_id? }
// Response (pending): { ok, status: 'pending', ref, sale_id, booking_id, url }
// Response (paid):    { ok, status: 'paid', ... }  (the same payload the reader flow returns)

import {
  SALE_COLUMNS,
  ackSale,
  completeSale,
  computeApplicationFeeCents,
  createPendingBooking,
  getSaleByRef,
  json,
  kioskAuthorized,
  logEvent,
  paidPayload,
  resolveEmployee,
  resolveKiosk,
  serviceClient,
  stripeConfigured,
  stripeCreateCheckoutSession,
  stripeRetrieveCheckoutSession,
  stripeRetrievePaymentIntent,
  type SaleRow,
} from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const REF_RE = /^KS-[A-Z0-9]{6,12}$/;
const APP_URL = Deno.env.get("APP_URL") ?? "https://primewillcall.com";

interface LinkBody {
  kiosk?: string;
  ref?: string;
  amount_cents?: number;
  product?: string;
  customer?: { name?: string };
  xano?: Record<string, unknown>;
  app_build?: string;
  device_id?: string;
  employee_id?: string;
}

Deno.serve(withSentry("kiosk-sale-link", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);
  if (!stripeConfigured()) return json({ error: "not_configured" }, 503);

  let body: LinkBody;
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
  const customerName = String(body.customer?.name ?? xano.customer_name ?? "").trim() || null;
  const employee = await resolveEmployee(sb, body.employee_id);
  const meta = {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    appBuild: body.app_build ?? null,
    deviceId: body.device_id ?? null,
    employeeId: employee?.id ?? null,
    employeeName: employee?.name ?? null,
  };

  // The same reference again: a re-scan, a tablet that came back, a retried request.
  // Never a second checkout and never a second charge.
  const existing = await getSaleByRef(sb, ref);
  if (existing) {
    if (existing.kiosk_id !== kiosk.id) return json({ error: "ref_conflict" }, 409);
    if (existing.amount_cents !== amount) return json({ error: "amount_mismatch", ref }, 409);
    if (existing.status === "paid") {
      const acked = await ackSale(sb, existing);
      return json(paidPayload(acked, { already: true }), 200);
    }
    if (existing.status === "abandoned") return json({ error: "sale_abandoned", ref }, 409);

    const stored = (existing.xano_payload as Record<string, unknown> | null) ?? {};
    const sessionId = typeof stored.__checkout_session === "string" ? stored.__checkout_session : null;
    const url = typeof stored.__checkout_url === "string" ? stored.__checkout_url : null;
    const acct = existing.stripe_account_id ?? account;

    // Has the guest paid? The session is the authority here, not the tablet and not
    // the intent (which does not exist until the guest starts paying).
    if (sessionId) {
      const r = await stripeRetrieveCheckoutSession(sessionId, acct);
      if (r.ok && r.session.payment_status === "paid" && r.session.payment_intent) {
        const pi = await stripeRetrievePaymentIntent(r.session.payment_intent, acct);
        if (pi.ok) {
          const { sale } = await completeSale(sb, existing, "tablet", pi.pi);
          const acked = await ackSale(sb, sale);
          return json(paidPayload(acked, { already: true }), 200);
        }
      }
      // Stripe expired or the guest cancelled the page: no payment is coming.
      if (r.ok && r.session.status === "expired") {
        return json({ ok: true, status: "expired", ref, sale_id: existing.id }, 200);
      }
    } else if (existing.payment_intent_id) {
      // A sale started by the reader flow, polled through here. Same answer.
      const pi = await stripeRetrievePaymentIntent(existing.payment_intent_id, acct);
      if (pi.ok && pi.pi.status === "succeeded") {
        const { sale } = await completeSale(sb, existing, "tablet", pi.pi);
        const acked = await ackSale(sb, sale);
        return json(paidPayload(acked, { already: true }), 200);
      }
    }

    // Still unpaid. The stored URL is the same page, so hand it back rather than
    // opening another one.
    if (url) {
      return json(
        {
          ok: true,
          status: "pending",
          ref,
          sale_id: existing.id,
          booking_id: existing.booking_id,
          url,
          resumed: true,
        },
        200,
      );
    }
  }

  // A new sale. The booking and the checkout page do not depend on each other, so
  // they are opened together: doing them in turn made staff wait about four seconds
  // with a dead button. The guest still cannot pay before the sale exists, because
  // the URL is only handed back once both have landed and the row is written.
  const fee = computeApplicationFeeCents(amount);
  const [bookingResult, session] = await Promise.all([
    existing?.booking_id
      ? Promise.resolve({ ok: true as const, bookingId: existing.booking_id })
      : createPendingBooking(sb, { ref, amountCents: amount, xanoPayload: xano }),
    stripeCreateCheckoutSession({
      account,
      amountCents: amount,
      feeCents: fee,
      productName: String(xano.product_var ?? xano.product ?? product),
      metadata: { booking_id: ref, kiosk_flow: "v2-link", kiosk: kiosk.slug },
      idempotencyKey: `${ref}:checkout`,
      successUrl: `${APP_URL}/kiosk/paid?ref=${encodeURIComponent(ref)}`,
      cancelUrl: `${APP_URL}/kiosk/paid?ref=${encodeURIComponent(ref)}&cancelled=1`,
    }),
  ]);

  if (!bookingResult.ok) {
    await logEvent(sb, {
      ...meta,
      ref,
      event: "sale_start_failed",
      level: "error",
      payload: { step: "booking", method: "link", error: bookingResult.error },
    });
    return json({ error: "booking_failed", message: bookingResult.error }, 502);
  }
  if (!session.ok) {
    await logEvent(sb, {
      ...meta,
      ref,
      event: "sale_start_failed",
      level: "error",
      payload: { step: "checkout", error: session.error },
    });
    return json({ error: "stripe_error", message: session.error }, 502);
  }

  const bookingId = bookingResult.bookingId;
  if (employee && !existing) {
    await sb.from("bookings").update({ kiosk_employee_id: employee.id }).eq("id", bookingId);
  }

  // One write, with everything on it: the session id is what the poll reads, and the
  // URL is what a re-scan gets back instead of a second checkout.
  let sale: SaleRow | null = existing;
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
        ...(session.paymentIntentId ? { payment_intent_id: session.paymentIntentId } : {}),
        xano_payload: { ...xano, __checkout_url: session.url, __checkout_session: session.sessionId },
        app_build: body.app_build ?? null,
        device_id: body.device_id ?? null,
        employee_id: employee?.id ?? null,
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
  } else {
    const { data: updated } = await sb
      .from("kiosk_sales")
      .update({
        ...(session.paymentIntentId ? { payment_intent_id: session.paymentIntentId } : {}),
        xano_payload: {
          ...(sale.xano_payload ?? {}),
          __checkout_url: session.url,
          __checkout_session: session.sessionId,
        },
      })
      .eq("id", sale.id)
      .select(SALE_COLUMNS)
      .maybeSingle<SaleRow>();
    if (updated) sale = updated;
  }

  await logEvent(sb, {
    ...meta,
    ref,
    event: "sale_started",
    payload: {
      method: "link",
      amount,
      fee,
      booking_id: bookingId,
      session: session.sessionId,
      customer_name: customerName,
    },
  });

  return json(
    { ok: true, status: "pending", ref, sale_id: sale.id, booking_id: bookingId, url: session.url },
    200,
  );
}));
