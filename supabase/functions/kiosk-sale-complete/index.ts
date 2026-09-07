// Kiosk card flow v2, step 2: the tablet reports what the reader said, and Stripe
// decides what actually happened.
//
// The tablet calls this after confirmPaymentIntent returns, whatever it returned:
// success, an error, or a cancel. We never trust that report for money. We retrieve
// the PaymentIntent from Stripe and act on ITS status:
//
//   succeeded  -> complete the sale (booking confirmed, ledger row, Xano mirror) and
//                 answer 'paid'. This is the case that used to become a double charge:
//                 the reader dropped after the capture, the tablet saw an error, and
//                 staff charged again. Now the tablet sees 'paid' and prints.
//   canceled   -> answer 'canceled'; the tablet starts over on a new sale.
//   anything else (requires_payment_method, processing ...) -> answer that status with
//                 the client secret, so a retry collects on the SAME intent.
//
// Idempotent: a sale already completed by the sweep answers 'paid' with already=true.
//
// Body: { kiosk, ref, outcome: 'succeeded' | 'error' | 'canceled', error?: { code?, message? },
//         sdk_status?, app_build?, device_id? }

import {
  ackSale,
  completeSale,
  getSaleByRef,
  json,
  kioskAuthorized,
  logEvent,
  paidPayload,
  resolveEmployee,
  resolveKiosk,
  serviceClient,
  stripeConfigured,
  stripeRetrievePaymentIntent,
} from "../_shared/kiosk-sale.ts";

interface CompleteBody {
  kiosk?: string;
  ref?: string;
  outcome?: string;
  error?: { code?: string; message?: string } | string | null;
  sdk_status?: string;
  app_build?: string;
  device_id?: string;
  employee_id?: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);
  if (!stripeConfigured()) return json({ error: "not_configured" }, 503);

  let body: CompleteBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  const ref = String(body.ref ?? "").trim().toUpperCase();
  const outcome = String(body.outcome ?? "").trim() || "unknown";
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  if (!ref) return json({ error: "bad_ref" }, 400);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk } = resolved;

  const sale = await getSaleByRef(sb, ref);
  if (!sale) return json({ error: "unknown_sale", ref }, 404);
  if (sale.kiosk_id !== kiosk.id) return json({ error: "ref_conflict" }, 409);

  const employee = await resolveEmployee(sb, kiosk.business_id, body.employee_id);
  const meta = {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    appBuild: body.app_build ?? null,
    deviceId: body.device_id ?? null,
    employeeId: employee?.id ?? null,
    employeeName: employee?.name ?? null,
  };
  const err =
    typeof body.error === "string" ? { message: body.error } : body.error ?? null;
  await logEvent(sb, {
    ...meta,
    ref,
    event: "card_result",
    level: outcome === "succeeded" ? "info" : "warn",
    payload: { outcome, sdk_status: body.sdk_status ?? null, error: err },
  });

  if (sale.status === "paid") {
    const acked = await ackSale(sb, sale);
    return json(paidPayload(acked, { already: true }), 200);
  }
  if (sale.status === "abandoned") return json({ ok: false, status: "abandoned", ref }, 409);
  if (!sale.payment_intent_id || !sale.stripe_account_id) {
    return json({ ok: true, status: "pending", ref }, 200);
  }

  const r = await stripeRetrievePaymentIntent(sale.payment_intent_id, sale.stripe_account_id);
  if (!r.ok) return json({ error: "stripe_error", message: r.error }, 502);

  if (r.pi.status === "succeeded") {
    const { sale: done, already } = await completeSale(sb, sale, "tablet", r.pi);
    const acked = await ackSale(sb, done);
    return json(paidPayload(acked, { already }), 200);
  }
  if (r.pi.status === "canceled") return json({ ok: true, status: "canceled", ref }, 200);
  return json(
    {
      ok: true,
      status: r.pi.status,
      ref,
      payment_intent: r.pi.client_secret,
      payment_intent_id: r.pi.id,
      account: sale.stripe_account_id,
    },
    200,
  );
});
