// Kiosk card flow v2, the safety net: pg_cron calls this every minute.
//
// A tablet can die at any point after the reader captured a payment. This sweep is
// what makes that harmless: for every pending sale older than a minute it asks Stripe
// whether the intent succeeded and, if so, completes the sale exactly as the tablet
// would have (booking confirmed, ledger row, Xano mirror). The customer's booking
// exists, the manifest shows them, and the next sale on that kiosk can be attached
// to this payment instead of charging the card again.
//
// It also keeps things tidy: an intent that never got a card within 30 minutes is
// cancelled on Stripe and the sale marked abandoned (the hidden booking stays hidden),
// and a paid sale whose Xano mirror failed is retried for 24 hours.
//
// Auth: x-cron-secret must equal CRON_SECRET (same as the messaging dispatcher).

import {
  ABANDON_AFTER_MS,
  SALE_COLUMNS,
  SWEEP_MIN_AGE_MS,
  XANO_NO_ID,
  logEvent,
  abandonSale,
  completeSale,
  json,
  mirrorAndRecord,
  serviceClient,
  stripeCancelPaymentIntent,
  stripeConfigured,
  stripeRetrievePaymentIntent,
  xanoMirrorEnabled,
  type SaleRow,
} from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

Deno.serve(withSentry("kiosk-sale-sweep", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!stripeConfigured()) return json({ error: "not_configured" }, 503);

  const sb = serviceClient();
  const now = Date.now();
  const counts = { scanned: 0, completed: 0, abandoned: 0, mirrored: 0, errors: 0 };

  // 1. Pending sales the tablet went quiet on.
  const { data: pending } = await sb
    .from("kiosk_sales")
    .select(SALE_COLUMNS)
    .eq("status", "pending")
    .lt("created_at", new Date(now - SWEEP_MIN_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(50)
    .returns<SaleRow[]>();

  for (const sale of pending ?? []) {
    counts.scanned++;
    const age = now - new Date(sale.created_at).getTime();
    if (!sale.payment_intent_id || !sale.stripe_account_id) {
      if (age > ABANDON_AFTER_MS) {
        await abandonSale(sb, sale, "no_intent");
        counts.abandoned++;
      }
      continue;
    }
    const r = await stripeRetrievePaymentIntent(sale.payment_intent_id, sale.stripe_account_id);
    if (!r.ok) {
      counts.errors++;
      continue;
    }
    if (r.pi.status === "succeeded") {
      const { already } = await completeSale(sb, sale, "sweep", r.pi);
      if (!already) counts.completed++;
      continue;
    }
    if (r.pi.status === "canceled") {
      await abandonSale(sb, sale, "intent_canceled");
      counts.abandoned++;
      continue;
    }
    const uncollected = ["requires_payment_method", "requires_confirmation", "requires_action"];
    if (age > ABANDON_AFTER_MS && uncollected.includes(r.pi.status)) {
      // Nothing was ever collected on it. Cancel on Stripe FIRST and close the sale only
      // once Stripe confirms the cancel, so an intent that is still able to succeed
      // (a "processing" one, or a cancel that failed) is never marked abandoned.
      const c = await stripeCancelPaymentIntent(sale.payment_intent_id, sale.stripe_account_id);
      if (c.ok && c.pi.status === "canceled") {
        await abandonSale(sb, sale, "expired");
        counts.abandoned++;
      } else {
        counts.errors++;
        await logEvent(sb, {
          kioskId: sale.kiosk_id,
          kioskSlug: sale.kiosk_slug,
          businessId: sale.business_id,
          ref: sale.ref,
          event: "sale_cancel_failed",
          level: "warn",
          payload: { error: c.ok ? c.pi.status : c.error },
        });
      }
    }
  }

  // 2. Paid sales Xano has not fully received (booking or cash_sales post failed): retry
  //    for a day. A booking post that answered without an id is NOT retried, because Xano
  //    may have created it; that one is left flagged in xano_error for a person.
  if (xanoMirrorEnabled()) {
    const { data: unmirrored } = await sb
      .from("kiosk_sales")
      .select(SALE_COLUMNS)
      .eq("status", "paid")
      .is("xano_mirrored_at", null)
      .or(`xano_error.is.null,xano_error.neq.${XANO_NO_ID}`)
      .gte("created_at", new Date(now - 24 * 3600_000).toISOString())
      .order("created_at", { ascending: true })
      .limit(20)
      .returns<SaleRow[]>();
    for (const sale of unmirrored ?? []) {
      const after = await mirrorAndRecord(sb, sale);
      if (after.xano_mirrored_at) counts.mirrored++;
    }
  }

  return json({ ok: true, ...counts }, 200);
}));
