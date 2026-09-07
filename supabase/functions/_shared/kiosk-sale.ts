/**
 * Kiosk card flow v2: shared logic for kiosk-sale-start, kiosk-sale-complete and
 * kiosk-sale-sweep (see docs/kiosk-card-flow-v2.md).
 *
 * The sale is written BEFORE the card is read, as a hidden pending booking plus a
 * kiosk_sales row; Stripe is the only authority on whether money moved; and the sale
 * is completed by whoever learns of the capture first (the tablet, or the sweep when
 * the tablet went quiet). Completion is idempotent: the claim is a single UPDATE
 * guarded on status = 'pending', so two callers can never both write the sale.
 *
 * Nothing in this module is reachable from the v1 flow. The old app calls
 * kiosk-payment-intent / kiosk-cash-sale / kiosk-booking, none of which import it.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { nyLocalToUtcIso } from "./ny-time.ts";

// ── environment ───────────────────────────────────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const PLATFORM_FEE_BPS = Number(Deno.env.get("STRIPE_PLATFORM_FEE_BPS") ?? "25");
const XANO_WEBHOOK_SECRET = Deno.env.get("XANO_WEBHOOK_SECRET") ?? "";
const KIOSK_SHARED_SECRET = Deno.env.get("KIOSK_SHARED_SECRET") ?? "";

/**
 * The same public Xano endpoints the tablet posts to today. In v2 the server posts
 * them instead, so Bubble's manifests keep seeing every card sale even when the
 * tablet died mid-sale. Set KIOSK_V2_XANO_MIRROR=false to stop the mirror.
 */
export const XANO_BOOKING_URL = "https://xmhi-aj9d-cnsb.n7.xano.io/api:2k2IsvEZ/booking";
export const XANO_CASH_SALES_URL = "https://xmhi-aj9d-cnsb.n7.xano.io/api:_o9979qq/cash_sales";
const XANO_TIMEOUT_MS = 8_000;

export const REUSE_WINDOW_MS = 5 * 60_000;
/** Inside this window a matching amount is enough: the tablet just crashed and came back. */
export const REUSE_NO_NAME_WINDOW_MS = 2 * 60_000;
export const SWEEP_MIN_AGE_MS = 60_000;
export const ABANDON_AFTER_MS = 30 * 60_000;

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Same optional hardening as the other kiosk functions: off unless the secret is set. */
export function kioskAuthorized(req: Request): boolean {
  if (!KIOSK_SHARED_SECRET) return true;
  return req.headers.get("x-kiosk-secret") === KIOSK_SHARED_SECRET;
}

export function stripeConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY);
}

export function xanoMirrorEnabled(): boolean {
  return Deno.env.get("KIOSK_V2_XANO_MIRROR") !== "false";
}

/** Platform fee (cents): global rate, floored, clamped below the amount. Mirrors kiosk-payment-intent. */
export function computeApplicationFeeCents(amount: number): number {
  const bps = Number.isFinite(PLATFORM_FEE_BPS) ? PLATFORM_FEE_BPS : 25;
  const fee = Math.floor((amount * bps) / 10000);
  if (fee <= 0) return 0;
  return Math.min(fee, amount - 1);
}

// ── kiosk lookup ──────────────────────────────────────────────────────────────
export interface KioskRow {
  id: string;
  slug: string;
  business_id: string | null;
  stripe_account_id: string | null;
  card_flow: string;
  reader_low_battery_pct: number;
  reader_block_battery_pct: number;
  simulated: boolean | null;
}

export interface ResolvedKiosk {
  kiosk: KioskRow;
  /** Connected account the sale settles on (kiosk override, else the business's). */
  account: string | null;
}

export async function resolveKiosk(sb: SupabaseClient, slug: string): Promise<ResolvedKiosk | null> {
  const { data: kiosk } = await sb
    .from("kiosks")
    .select("id, slug, business_id, stripe_account_id, card_flow, reader_low_battery_pct, reader_block_battery_pct, simulated")
    .eq("slug", slug)
    .maybeSingle<KioskRow>();
  if (!kiosk) return null;

  let account: string | null = kiosk.stripe_account_id ?? null;
  if (!account && kiosk.business_id) {
    const { data: biz } = await sb
      .from("businesses")
      .select("stripe_account_id")
      .eq("id", kiosk.business_id)
      .maybeSingle<{ stripe_account_id: string | null }>();
    account = biz?.stripe_account_id ?? null;
  }
  return { kiosk, account };
}

// ── Stripe (raw REST, same shape kiosk-payment-intent uses) ───────────────────
export interface StripePaymentIntent {
  id: string;
  status: string;
  client_secret?: string | null;
  amount: number;
  latest_charge?: string | null;
  metadata?: Record<string, string>;
}

type StripeResult = { ok: true; pi: StripePaymentIntent } | { ok: false; error: string; status: number };

async function stripeCall(
  path: string,
  account: string,
  init: { method: "GET" | "POST"; form?: Record<string, string>; idempotencyKey?: string },
): Promise<StripeResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    "Stripe-Account": account,
  };
  let body: string | undefined;
  if (init.method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form ?? {}).toString();
  }
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  try {
    const res = await fetch(`https://api.stripe.com${path}`, { method: init.method, headers, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) {
      return { ok: false, error: data?.error?.message ?? `stripe ${res.status}`, status: res.status };
    }
    return { ok: true, pi: data as StripePaymentIntent };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 0 };
  }
}

/** Create a card_present PaymentIntent as a direct charge with the platform fee (idempotent on the sale ref). */
export function stripeCreatePaymentIntent(opts: {
  account: string;
  amountCents: number;
  feeCents: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
}): Promise<StripeResult> {
  const form: Record<string, string> = {
    amount: String(opts.amountCents),
    currency: "usd",
    "payment_method_types[]": "card_present",
    capture_method: "automatic",
  };
  if (opts.feeCents > 0) form["application_fee_amount"] = String(opts.feeCents);
  for (const [k, v] of Object.entries(opts.metadata)) form[`metadata[${k}]`] = v;
  return stripeCall("/v1/payment_intents", opts.account, {
    method: "POST",
    form,
    idempotencyKey: opts.idempotencyKey,
  });
}

export function stripeRetrievePaymentIntent(id: string, account: string): Promise<StripeResult> {
  return stripeCall(`/v1/payment_intents/${encodeURIComponent(id)}`, account, { method: "GET" });
}

export function stripeCancelPaymentIntent(id: string, account: string): Promise<StripeResult> {
  return stripeCall(`/v1/payment_intents/${encodeURIComponent(id)}/cancel`, account, {
    method: "POST",
    form: { cancellation_reason: "abandoned" },
  });
}

// ── dates ─────────────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The tablet's date_time string, "Sep 7 2026 10:30 AM" or "Sep 7 2026", as a New York
 * calendar date (YYYY-MM-DD) plus an optional 24h time (HH:mm).
 */
export function parseXanoDateTime(s: string): { date: string; time: string | null } | null {
  const m = String(s ?? "")
    .trim()
    .match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31) return null;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!m[4]) return { date, time: null };
  let hh = Number(m[4]) % 12;
  if (m[6].toUpperCase() === "PM") hh += 12;
  const time = `${String(hh).padStart(2, "0")}:${m[5]}`;
  return { date, time };
}

/** UTC instant for the tablet's date_time; a date without a time lands at noon UTC like the sync does. */
export function startsAtFromXanoDateTime(s: string): string | null {
  const parsed = parseXanoDateTime(s);
  if (!parsed) return null;
  if (!parsed.time) return `${parsed.date}T12:00:00.000Z`;
  return nyLocalToUtcIso(parsed.date, parsed.time);
}

// ── reuse rule ────────────────────────────────────────────────────────────────
export function normalizeFirstName(name: string | null | undefined): string {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ReuseCandidate {
  amount_cents: number;
  customer_name: string | null;
  tablet_acked_at: string | null;
  status: string;
  created_at: string;
}

/**
 * Whether a sale started right after an unacknowledged captured payment on the same
 * kiosk is that payment's retry. Always required: same amount, the earlier sale was
 * never acknowledged by a tablet (acknowledged means a tablet showed it as paid, which
 * happens within seconds whenever the tablet is alive), and it is under five minutes
 * old. Under two minutes that is enough: the tablet crashed and came back, and staff are
 * re-entering the same customer, name typos included. Between two and five minutes the
 * first name has to match too, with prefix tolerance ("Rachel" / "Rachelle"), or the
 * earlier sale had no real name. A different customer paying the same amount in that
 * gap would then be under-collected once, never double charged.
 */
export function canReuseSale(
  candidate: ReuseCandidate,
  incoming: { amountCents: number; customerName: string | null },
  now: number = Date.now(),
): boolean {
  if (candidate.status !== "paid") return false;
  if (candidate.tablet_acked_at) return false;
  if (candidate.amount_cents !== incoming.amountCents) return false;
  const age = now - new Date(candidate.created_at).getTime();
  if (!(age >= 0 && age <= REUSE_WINDOW_MS)) return false;
  if (age <= REUSE_NO_NAME_WINDOW_MS) return true;
  const prev = normalizeFirstName(candidate.customer_name);
  const next = normalizeFirstName(incoming.customerName);
  if (!prev || prev === "walkin" || prev === "guest") return true;
  if (prev === next) return true;
  const shorter = Math.min(prev.length, next.length);
  return shorter >= 3 && (prev.startsWith(next) || next.startsWith(prev));
}

// ── events ────────────────────────────────────────────────────────────────────
export interface KioskEvent {
  kioskId?: string | null;
  kioskSlug?: string | null;
  businessId?: string | null;
  ref?: string | null;
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  payload?: Record<string, unknown>;
  appBuild?: string | null;
  deviceId?: string | null;
  clientAt?: string | null;
}

/** Append one event. Best-effort: a logging failure never fails a sale. */
export async function logEvent(sb: SupabaseClient, e: KioskEvent): Promise<void> {
  try {
    await sb.from("kiosk_events").insert({
      kiosk_id: e.kioskId ?? null,
      kiosk_slug: e.kioskSlug ?? null,
      business_id: e.businessId ?? null,
      ref: e.ref ?? null,
      event: e.event,
      level: e.level ?? "info",
      payload: e.payload ?? {},
      app_build: e.appBuild ?? null,
      device_id: e.deviceId ?? null,
      client_at: e.clientAt ?? null,
    });
  } catch {
    // never block a sale on logging
  }
}

// ── the sale row ──────────────────────────────────────────────────────────────
export interface SaleRow {
  id: string;
  ref: string;
  kiosk_id: string;
  kiosk_slug: string;
  business_id: string;
  type: string;
  amount_cents: number;
  product: string | null;
  customer_name: string | null;
  status: "pending" | "paid" | "abandoned";
  payment_intent_id: string | null;
  stripe_account_id: string | null;
  booking_id: string | null;
  cash_sale_id: string | null;
  xano_payload: Record<string, unknown>;
  xano_booking_id: string | null;
  xano_payment_qr: string | null;
  xano_mirrored_at: string | null;
  xano_error: string | null;
  paid_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  tablet_acked_at: string | null;
  app_build: string | null;
  device_id: string | null;
  created_at: string;
}

export const SALE_COLUMNS =
  "id, ref, kiosk_id, kiosk_slug, business_id, type, amount_cents, product, customer_name, status, " +
  "payment_intent_id, stripe_account_id, booking_id, cash_sale_id, xano_payload, xano_booking_id, " +
  "xano_payment_qr, xano_mirrored_at, xano_error, paid_at, completed_at, completed_by, tablet_acked_at, " +
  "app_build, device_id, created_at";

export async function getSaleByRef(sb: SupabaseClient, ref: string): Promise<SaleRow | null> {
  const { data } = await sb.from("kiosk_sales").select(SALE_COLUMNS).eq("ref", ref).maybeSingle<SaleRow>();
  return data ?? null;
}

/** What the tablet needs back once a sale is paid. */
export function paidPayload(sale: SaleRow, extra: { reused?: boolean; already?: boolean } = {}) {
  return {
    ok: true,
    status: "paid" as const,
    ref: sale.ref,
    sale_id: sale.id,
    booking_id: sale.booking_id,
    payment_qr: sale.xano_payment_qr,
    xano_booking_id: sale.xano_booking_id,
    customer_name: sale.customer_name,
    amount: sale.amount_cents,
    reused: Boolean(extra.reused),
    already: Boolean(extra.already),
  };
}

// ── pending booking (through the proven xano-booking-sync ingest) ─────────────
/**
 * Create the hidden pending booking for a sale. The record goes through the same
 * ingest Xano's own trigger uses, so product, business, customer and times are mapped
 * by one piece of code, and when the Xano mirror later comes back through that trigger
 * it converges on this same row (legacy_id = the KS code).
 */
export async function createPendingBooking(
  sb: SupabaseClient,
  sale: { ref: string; amountCents: number; xanoPayload: Record<string, unknown> },
): Promise<{ ok: true; bookingId: string } | { ok: false; error: string }> {
  if (!XANO_WEBHOOK_SECRET) return { ok: false, error: "XANO_WEBHOOK_SECRET not set" };
  const startsAt = startsAtFromXanoDateTime(String(sale.xanoPayload.date_time ?? ""));
  if (!startsAt) return { ok: false, error: "bad date_time" };

  const record: Record<string, unknown> = {
    ...sale.xanoPayload,
    unique_id: sale.ref,
    internal_id: sale.ref,
    status: "pending",
    starts_at: startsAt,
    // The ingest reads price as DOLLARS; the tablet's payload carries cents.
    price: (sale.amountCents / 100).toFixed(2),
  };
  delete record.date_timestamp;
  delete record.id;

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/xano-booking-sync`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": XANO_WEBHOOK_SECRET },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: `sync unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const data = await res.json().catch(() => ({}));
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  if (!res.ok || !first?.ok) {
    return { ok: false, error: `sync: ${first?.error ?? data?.error ?? res.status}` };
  }

  const { data: booking } = await sb
    .from("bookings")
    .select("id")
    .eq("legacy_id", sale.ref)
    .maybeSingle<{ id: string }>();
  if (!booking) return { ok: false, error: "booking not found after sync" };

  // Hidden from every staff screen until Stripe confirms (bookings_select policy).
  const { error } = await sb
    .from("bookings")
    .update({ awaiting_payment: true, status: "pending" })
    .eq("id", booking.id);
  if (error) return { ok: false, error: `hide: ${error.message}` };
  return { ok: true, bookingId: booking.id };
}

// ── Xano mirror ───────────────────────────────────────────────────────────────
export interface MirrorResult {
  ok: boolean;
  xanoBookingId: string | null;
  paymentQr: string | null;
  error: string | null;
}

export const XANO_NO_ID = "xano booking: no id in response";

/** POST the booking record to Xano exactly as the tablet does today. Never throws. */
async function postXanoBooking(
  sale: SaleRow,
): Promise<{ ok: true; id: string; paymentQr: string | null } | { ok: false; error: string }> {
  const payload = {
    ...sale.xano_payload,
    internal_id: sale.ref,
    status: "confirmed",
    payment_status: "completed",
  };
  delete (payload as Record<string, unknown>).starts_at;
  try {
    const res = await fetch(XANO_BOOKING_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(XANO_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `xano booking ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    const id = data?.id != null ? String(data.id) : "";
    if (!id) return { ok: false, error: XANO_NO_ID };
    return { ok: true, id, paymentQr: typeof data?.payment_qr === "string" ? data.payment_qr : null };
  } catch (err) {
    return { ok: false, error: `xano booking: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** POST the cash_sales row that references the Xano booking (same payload as the tablet). */
async function postXanoCashSale(sale: SaleRow, xanoBookingId: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch(XANO_CASH_SALES_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        booking_id: xanoBookingId,
        amount: (sale.amount_cents / 100).toFixed(2),
        type: "card",
        product: sale.product || "ticket",
        kiosk: String(sale.xano_payload.kiosk ?? ""),
        status: "success",
      }),
      signal: AbortSignal.timeout(XANO_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `xano cash_sales ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: `xano cash_sales: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Run (or resume) the Xano mirror for a paid sale and record the outcome on the row.
 * Resumable: a sale that already has its Xano booking only retries the cash_sales post,
 * so a retry can never create a second Xano booking. `xano_mirrored_at` is set only when
 * both posts succeeded, which is what the sweep keys its retries on.
 */
export async function mirrorAndRecord(sb: SupabaseClient, sale: SaleRow): Promise<SaleRow> {
  if (!xanoMirrorEnabled() || sale.xano_mirrored_at) return sale;

  let bookingId = sale.xano_booking_id;
  let paymentQr = sale.xano_payment_qr;
  let error: string | null = null;
  if (!bookingId) {
    const b = await postXanoBooking(sale);
    if (!b.ok) {
      error = b.error;
    } else {
      bookingId = b.id;
      paymentQr = b.paymentQr ?? paymentQr;
    }
  }
  if (bookingId && !error) {
    const c = await postXanoCashSale(sale, bookingId);
    error = c.error;
  }

  const patch: Record<string, unknown> = {
    xano_error: error,
    xano_mirrored_at: error ? null : new Date().toISOString(),
  };
  if (bookingId) patch.xano_booking_id = bookingId;
  if (paymentQr) patch.xano_payment_qr = paymentQr;
  const { data } = await sb.from("kiosk_sales").update(patch).eq("id", sale.id).select(SALE_COLUMNS).maybeSingle<SaleRow>();
  await logEvent(sb, {
    kioskId: sale.kiosk_id,
    kioskSlug: sale.kiosk_slug,
    businessId: sale.business_id,
    ref: sale.ref,
    event: error ? "xano_mirror_failed" : "xano_mirrored",
    level: error ? "error" : "info",
    payload: { xano_booking_id: bookingId, error },
  });
  return data ?? sale;
}

// ── completion ────────────────────────────────────────────────────────────────
/**
 * Turn a captured payment into a real sale. Safe to call from several places at once:
 * only the caller whose claim UPDATE flips status from pending to paid does the writes.
 */
export async function completeSale(
  sb: SupabaseClient,
  sale: SaleRow,
  by: "tablet" | "sweep" | "reuse",
  pi: StripePaymentIntent,
): Promise<{ sale: SaleRow; already: boolean }> {
  const now = new Date().toISOString();
  const { data: claimed } = await sb
    .from("kiosk_sales")
    .update({
      status: "paid",
      paid_at: now,
      completed_at: now,
      completed_by: by,
      payment_intent_id: sale.payment_intent_id ?? pi.id,
    })
    .eq("id", sale.id)
    .eq("status", "pending")
    .select(SALE_COLUMNS)
    .maybeSingle<SaleRow>();

  if (!claimed) {
    const current = (await getSaleByRef(sb, sale.ref)) ?? sale;
    return { sale: current, already: true };
  }
  let current = claimed;

  if (current.booking_id) {
    await sb
      .from("bookings")
      .update({
        awaiting_payment: false,
        status: "confirmed",
        paid_at: now,
        stripe_payment_intent_id: pi.id,
      })
      .eq("id", current.booking_id);
  }

  // The ledger row the payments screen and the reconciliation read (same shape the
  // old app's kiosk-cash-sale write produces, same dedup key format).
  const { data: cashSale } = await sb
    .from("cash_sales")
    .upsert(
      {
        business_id: current.business_id,
        kiosk_id: current.kiosk_id,
        booking_id: current.booking_id,
        booking_ref: current.ref,
        amount_cents: current.amount_cents,
        type: "card",
        product: current.product || "ticket",
        status: "success",
        source: "kiosk",
        kiosk_slug: current.kiosk_slug,
        dedup_key: `${current.ref}:card`,
      },
      { onConflict: "dedup_key" },
    )
    .select("id")
    .maybeSingle<{ id: string }>();
  if (cashSale?.id) {
    const { data } = await sb
      .from("kiosk_sales")
      .update({ cash_sale_id: cashSale.id })
      .eq("id", current.id)
      .select(SALE_COLUMNS)
      .maybeSingle<SaleRow>();
    if (data) current = data;
  }

  current = await mirrorAndRecord(sb, current);

  // Attach the customer's name and booking to the Stripe charge in the ledger.
  try {
    await sb.rpc("heal_ledger_booking_links", { p_refs: [current.ref] });
  } catch {
    // the webhook or the next sweep heals it
  }

  await logEvent(sb, {
    kioskId: current.kiosk_id,
    kioskSlug: current.kiosk_slug,
    businessId: current.business_id,
    ref: current.ref,
    event: "sale_completed",
    payload: { by, payment_intent: pi.id, amount: current.amount_cents, xano_booking_id: current.xano_booking_id },
  });
  return { sale: current, already: false };
}

/** Stamp that a tablet has shown the paid outcome for this sale (so it can never be reused). */
export async function ackSale(sb: SupabaseClient, sale: SaleRow): Promise<SaleRow> {
  if (sale.tablet_acked_at) return sale;
  const { data } = await sb
    .from("kiosk_sales")
    .update({ tablet_acked_at: new Date().toISOString() })
    .eq("id", sale.id)
    .select(SALE_COLUMNS)
    .maybeSingle<SaleRow>();
  return data ?? sale;
}

export async function abandonSale(sb: SupabaseClient, sale: SaleRow, reason: string): Promise<void> {
  await sb
    .from("kiosk_sales")
    .update({ status: "abandoned", completed_at: new Date().toISOString() })
    .eq("id", sale.id)
    .eq("status", "pending");
  await logEvent(sb, {
    kioskId: sale.kiosk_id,
    kioskSlug: sale.kiosk_slug,
    businessId: sale.business_id,
    ref: sale.ref,
    event: "sale_abandoned",
    level: "warn",
    payload: { reason, payment_intent: sale.payment_intent_id },
  });
}
