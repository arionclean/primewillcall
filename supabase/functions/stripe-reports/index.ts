// Stripe reports for the owner's Payouts tab on /admin/payments.
//
// READS Stripe, never writes to it. The only thing it writes is our own copy of
// each payout (`stripe_payouts`), so the tab can list the history fast and update
// live. Three actions:
//
//   overview       Per business: account health, balance and the next payout
//                  (see nextPayout). Also re-reads the latest payouts into
//                  stripe_payouts, so an in-transit payout flips to paid every
//                  time the tab opens, with or without the payout webhook events.
//                  (Disputes have their own tab and function, stripe-disputes.)
//   payout_detail  What went into one payout: every sale, refund, dispute and
//                  fee, matched to our ledger for the guest's name and booking.
//   backfill       Every payout each account has ever made, into stripe_payouts.
//                  Run once by hand (service role) and safe to re-run.
//
// Deployed with JWT ON. Owner only: requireStaff turns the caller's token into
// their staff row and anything but an owner is refused (the owner's call,
// 2026-10-06). The service role key is also accepted, so the backfill (and a
// check of any action) can be run from a terminal without signing in; that key
// already reaches everything, so this opens nothing (see isServiceRoleToken).
//
// Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key). Direct charges live on each
// business's connected account, so every read passes `stripeAccount`.

import type Stripe from "npm:stripe@22.3.0";

import { getStripe, stripeConfigured, stripeErrorMessage } from "../_shared/stripe.ts";
import { BROWSER_PREFLIGHT_HEADERS } from "../_shared/browser-cors.ts";
import { db, json } from "../_shared/sms.ts";
import { requireStaff } from "../_shared/staff-auth.ts";
import { withSentry } from "../_shared/sentry.ts";
import { PAYOUT_EXPAND, type PayoutRow, payoutRow, upsertPayouts } from "../_shared/stripe-payouts.ts";

type Action = "overview" | "payout_detail" | "backfill";

interface Payload {
  action?: Action;
  payout_id?: string;
}

interface BusinessRow {
  id: string;
  name: string;
  stripe_account_id: string;
  stripe_account_id_legacy: string[] | null;
}

/** How many of each account's latest payouts the overview re-reads. */
const RECENT_PAYOUTS = 30;
/** A payout itemizes into at most this many lines on screen. */
const MAX_DETAIL_LINES = 2000;

async function loadBusinesses(): Promise<BusinessRow[]> {
  const { data } = await db
    .from("businesses")
    .select("id, name, stripe_account_id, stripe_account_id_legacy")
    .not("stripe_account_id", "is", null)
    .order("name");
  return (data as BusinessRow[] | null) ?? [];
}

/** Every account a business has taken money on: the live one first, then retired ones. */
function accountsOf(biz: BusinessRow): string[] {
  return [biz.stripe_account_id, ...(biz.stripe_account_id_legacy ?? [])].filter(
    (id, i, all) => id && all.indexOf(id) === i,
  );
}

function usd(amounts: { amount: number; currency: string }[] | undefined): number {
  return (amounts ?? []).filter((a) => a.currency === "usd").reduce((s, a) => s + a.amount, 0);
}

// ── Account health in plain words ────────────────────────────────────────────

/**
 * Stripe names what it needs with field paths ("individual.verification.document").
 * The owner sees a short phrase instead. Unknown paths fall back to their last
 * readable segment, so a new requirement still says something sensible.
 */
const REQUIREMENT_LABELS: [RegExp, string][] = [
  [/external_account/, "Bank account for payouts"],
  [/verification\.(additional_)?document/, "ID document"],
  [/company\.verification/, "Business verification document"],
  [/(ssn_last_4|id_number)/, "Social Security number"],
  [/tax_id/, "Business tax ID (EIN)"],
  [/tos_acceptance/, "Accept Stripe's terms"],
  [/business_profile\.url/, "Business website"],
  [/business_profile\.(mcc|product_description)/, "What the business sells"],
  [/(representative|owners|directors|executives|person_)/, "Owner or representative details"],
  [/company\./, "Business details"],
  [/(dob|first_name|last_name|address|phone|email)/, "Personal details"],
];

function requirementLabel(path: string): string {
  for (const [re, label] of REQUIREMENT_LABELS) if (re.test(path)) return label;
  const last = path.split(".").pop() ?? path;
  const words = last.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function uniqueLabels(paths: string[] | null | undefined): string[] {
  return [...new Set((paths ?? []).map(requirementLabel))];
}

type HealthLevel = "ok" | "attention" | "blocked";

function health(account: Stripe.Account) {
  const req = account.requirements;
  const messages: string[] = [];
  let level: HealthLevel = "ok";

  if (!account.charges_enabled) {
    level = "blocked";
    messages.push("Stripe has paused card payments for this business.");
  }
  if (!account.payouts_enabled) {
    level = "blocked";
    messages.push("Stripe has paused payouts to the bank.");
  }
  const pastDue = uniqueLabels(req?.past_due);
  if (pastDue.length > 0) {
    level = "blocked";
    messages.push(`Stripe needs this now: ${pastDue.join(", ")}.`);
  }
  const due = uniqueLabels(req?.currently_due).filter((l) => !pastDue.includes(l));
  if (due.length > 0) {
    if (level === "ok") level = "attention";
    messages.push(`Stripe needs: ${due.join(", ")}.`);
  }
  for (const e of req?.errors ?? []) {
    if (level === "ok") level = "attention";
    messages.push(e.reason);
  }
  const future = uniqueLabels(account.future_requirements?.currently_due);
  if (level === "ok" && future.length > 0) {
    level = "attention";
    messages.push(`Stripe will soon need: ${future.join(", ")}.`);
  }

  const deadline = req?.current_deadline ?? account.future_requirements?.current_deadline ?? null;
  return {
    level,
    messages,
    deadline: deadline ? new Date(deadline * 1000).toISOString() : null,
  };
}

// ── The next payout ──────────────────────────────────────────────────────────

/** A payout Stripe is making or will make. `date` is the day it reaches the bank. */
interface NextPayout {
  date: string; // YYYY-MM-DD
  amount: number; // cents
  /** True when Stripe has already sent it; false when it is still clearing. */
  onTheWay: boolean;
}

/** At most this many clearing transactions are read to date the next payout. */
const MAX_PENDING_SCAN = 2000;

/** Stripe dates a payout's arrival, and when funds clear, as midnight UTC of the day. */
function stripeDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Money still clearing, summed per day Stripe makes it available (`available_on`).
 * On an automatic schedule that day is the payout day: on these accounts a payout
 * arrives the day its funds clear (checked against Stripe's own payouts).
 *
 * Stripe has no "upcoming payout" object: a payout exists only once Stripe sends
 * it. So the next one is read from the balance itself. Transactions come newest
 * first and a charge clears a fixed delay after it is made, so the scan stops at
 * the first charge that has already cleared: only the pending ones are read.
 */
async function clearingByDay(stripe: Stripe, accountId: string): Promise<Map<string, number>> {
  const now = Math.floor(Date.now() / 1000);
  const byDay = new Map<string, number>();
  let scanned = 0;
  for await (const t of stripe.balanceTransactions.list({ limit: 100 }, { stripeAccount: accountId })) {
    if (t.available_on > now) {
      if (t.currency === "usd") {
        const day = stripeDay(t.available_on);
        byDay.set(day, (byDay.get(day) ?? 0) + t.net);
      }
    } else if (t.type === "charge" || t.type === "payment") {
      break; // everything older has cleared too
    }
    if (++scanned >= MAX_PENDING_SCAN) break;
  }
  return byDay;
}

/**
 * The next payout: one Stripe has already sent and that has not arrived (exact),
 * else the earliest day money finishes clearing, with what clears that day plus
 * anything already available (it goes out in the same payout).
 */
function nextPayout(recent: Stripe.Payout[], clearing: Map<string, number>, available: number): NextPayout | null {
  const sent = recent
    .filter((p) => p.status === "pending" || p.status === "in_transit")
    .sort((a, b) => a.arrival_date - b.arrival_date)[0];
  if (sent) return { date: stripeDay(sent.arrival_date), amount: sent.amount, onTheWay: true };

  const day = [...clearing.keys()].sort()[0];
  if (!day) return null;
  return { date: day, amount: clearing.get(day)! + Math.max(available, 0), onTheWay: false };
}

// ── Our ledger, for names and booking links ──────────────────────────────────

interface LedgerMatch {
  customer_name: string | null;
  booking_id: string | null;
  booking_ref: string | null;
  source: string | null;
  booking_starts_at: string | null;
}

/** Look charges up in stripe_transactions (and their bookings) in two queries. */
async function ledgerFor(chargeIds: string[]): Promise<Map<string, LedgerMatch>> {
  const out = new Map<string, LedgerMatch>();
  const ids = [...new Set(chargeIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const rows: {
    stripe_id: string;
    customer_name: string | null;
    booking_id: string | null;
    booking_ref: string | null;
    source: string | null;
  }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db
      .from("stripe_transactions")
      .select("stripe_id, customer_name, booking_id, booking_ref, source")
      .in("stripe_id", ids.slice(i, i + 200));
    rows.push(...(data ?? []));
  }

  const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter((id): id is string => !!id))];
  const startsAt = new Map<string, string>();
  for (let i = 0; i < bookingIds.length; i += 200) {
    const { data } = await db
      .from("bookings")
      .select("id, starts_at")
      .in("id", bookingIds.slice(i, i + 200));
    for (const b of data ?? []) if (b.starts_at) startsAt.set(b.id, b.starts_at);
  }

  for (const r of rows) {
    out.set(r.stripe_id, {
      customer_name: r.customer_name,
      booking_id: r.booking_id,
      booking_ref: r.booking_ref,
      source: r.source,
      booking_starts_at: r.booking_id ? startsAt.get(r.booking_id) ?? null : null,
    });
  }
  return out;
}

function chargeIdOf(charge: string | Stripe.Charge | null | undefined): string | null {
  if (!charge) return null;
  return typeof charge === "string" ? charge : charge.id;
}

// ── Payout sync ──────────────────────────────────────────────────────────────

/** Re-read an account's latest payouts into stripe_payouts; returns them. */
async function syncRecentPayouts(stripe: Stripe, accountId: string, businessId: string): Promise<Stripe.Payout[]> {
  const list = await stripe.payouts.list(
    { limit: RECENT_PAYOUTS, expand: PAYOUT_EXPAND.map((e) => `data.${e}`) },
    { stripeAccount: accountId },
  );
  await upsertPayouts(db, list.data.map((p) => payoutRow(p, accountId, businessId)));
  return list.data;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function overview(stripe: Stripe): Promise<Response> {
  const businesses = await loadBusinesses();

  const results = await Promise.all(businesses.map(async (biz) => {
    const [primary, ...previous] = accountsOf(biz);
    const opts = { stripeAccount: primary };
    try {
      // A failed sync or scan only costs its own line on the card; it must not
      // hide the balance and health.
      const [account, balance, recent, clearing] = await Promise.all([
        stripe.accounts.retrieve(primary),
        stripe.balance.retrieve({}, opts),
        syncRecentPayouts(stripe, primary, biz.id).catch((err) => {
          console.error(`[stripe-reports] payout sync failed for ${primary}:`, err);
          return null;
        }),
        clearingByDay(stripe, primary).catch((err) => {
          console.error(`[stripe-reports] clearing scan failed for ${primary}:`, err);
          return null;
        }),
        ...previous.map((acct) =>
          syncRecentPayouts(stripe, acct, biz.id).catch((err) => {
            console.error(`[stripe-reports] payout sync failed for ${acct}:`, err);
            return null;
          })
        ),
      ]);
      const available = usd(balance.available);

      // A retired account can still hold money that has to pay out.
      const previousBalances = (await Promise.all(previous.map(async (acct) => {
        try {
          const b = await stripe.balance.retrieve({}, { stripeAccount: acct });
          return { accountId: acct, available: usd(b.available), pending: usd(b.pending) };
        } catch {
          return null;
        }
      }))).filter((b): b is NonNullable<typeof b> => !!b && (b.available !== 0 || b.pending !== 0));

      return {
        id: biz.id,
        name: biz.name,
        accountId: primary,
        error: null as string | null,
        health: health(account),
        balance: { available, pending: usd(balance.pending) },
        // Left out (undefined) when Stripe could not be read for it; null means none.
        nextPayout: recent && clearing ? nextPayout(recent, clearing, available) : undefined,
        previous: previousBalances,
      };
    } catch (err) {
      console.error(`[stripe-reports] overview failed for ${biz.name}:`, err);
      return {
        id: biz.id,
        name: biz.name,
        accountId: primary,
        error: stripeErrorMessage(err),
        health: null,
        balance: null,
        nextPayout: undefined,
        previous: [],
      };
    }
  }));

  return json({ businesses: results });
}

type LineKind = "sale" | "refund" | "dispute" | "other";

function lineKind(t: Stripe.BalanceTransaction): LineKind {
  if (t.type === "charge" || t.type === "payment") return "sale";
  if (t.type === "refund" || t.type === "payment_refund") return "refund";
  if (t.reporting_category === "dispute" || t.reporting_category === "dispute_reversal") return "dispute";
  return "other";
}

/** The charge a balance transaction is about, whatever its source object is. */
function chargeOfTransaction(t: Stripe.BalanceTransaction): string | null {
  const src = t.source;
  if (!src || typeof src === "string") return null;
  switch (src.object) {
    case "charge":
      return src.id;
    case "refund":
      return chargeIdOf((src as Stripe.Refund).charge);
    case "dispute":
      return chargeIdOf((src as Stripe.Dispute).charge);
    default:
      return null;
  }
}

async function payoutDetail(stripe: Stripe, payoutId: string): Promise<Response> {
  // The account comes from our own row, never from the caller.
  const { data: payout } = await db
    .from("stripe_payouts")
    .select("stripe_payout_id, connected_account_id, automatic, amount")
    .eq("stripe_payout_id", payoutId)
    .maybeSingle();
  if (!payout) return json({ error: "Payout not found." }, 404);
  if (!payout.automatic) {
    return json({
      lines: [],
      truncated: false,
      note: "This payout was sent by hand, so Stripe does not list what went into it.",
    });
  }

  const transactions: Stripe.BalanceTransaction[] = [];
  let truncated = false;
  try {
    for await (
      const t of stripe.balanceTransactions.list(
        { payout: payoutId, limit: 100, expand: ["data.source"] },
        { stripeAccount: payout.connected_account_id },
      )
    ) {
      if (t.type === "payout") continue; // the payout itself, not something in it
      if (transactions.length >= MAX_DETAIL_LINES) {
        truncated = true;
        break;
      }
      transactions.push(t);
    }
  } catch (err) {
    console.error("[stripe-reports] payout detail failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }

  const ledger = await ledgerFor(transactions.map((t) => chargeOfTransaction(t) ?? ""));

  const lines = transactions
    .map((t) => {
      const chargeId = chargeOfTransaction(t);
      const match = chargeId ? ledger.get(chargeId) : undefined;
      const src = t.source && typeof t.source !== "string" ? t.source : null;
      const charge = src?.object === "charge" ? (src as Stripe.Charge) : null;
      const sum = (type: string) =>
        t.fee_details.filter((f) => f.type === type).reduce((s, f) => s + f.amount, 0);
      return {
        id: t.id,
        kind: lineKind(t),
        created: new Date(t.created * 1000).toISOString(),
        amount: t.amount,
        fee: t.fee,
        stripeFee: sum("stripe_fee"),
        platformFee: sum("application_fee"),
        net: t.net,
        description: t.description,
        customerName: match?.customer_name ?? charge?.billing_details?.name ?? null,
        bookingId: match?.booking_id ?? null,
        bookingRef: match?.booking_ref ?? charge?.metadata?.booking_id ?? null,
        bookingStartsAt: match?.booking_starts_at ?? null,
        source: match?.source ?? charge?.metadata?.kiosk ?? charge?.metadata?.source ?? null,
      };
    })
    .sort((a, b) => a.created.localeCompare(b.created));

  return json({ lines, truncated, note: null });
}

async function backfill(stripe: Stripe): Promise<Response> {
  const businesses = await loadBusinesses();
  const counts = await Promise.all(businesses.flatMap((biz) =>
    accountsOf(biz).map(async (acct) => {
      const rows: PayoutRow[] = [];
      try {
        for await (
          const p of stripe.payouts.list(
            { limit: 100, expand: PAYOUT_EXPAND.map((e) => `data.${e}`) },
            { stripeAccount: acct },
          )
        ) {
          rows.push(payoutRow(p, acct, biz.id));
        }
        await upsertPayouts(db, rows);
        return { business: biz.name, account: acct, payouts: rows.length, error: null };
      } catch (err) {
        console.error(`[stripe-reports] backfill failed for ${acct}:`, err);
        return { business: biz.name, account: acct, payouts: rows.length, error: stripeErrorMessage(err) };
      }
    })
  ));
  return json({ ok: true, accounts: counts });
}

/**
 * True when the caller sent the service role key. The gateway (verify_jwt ON) has
 * already checked the token's signature, so its `role` claim can be trusted here.
 * Compared by claim, not by string: the key the platform injects into the function
 * is not always the same string as the one in the project's settings.
 */
function isServiceRoleToken(req: Request): boolean {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const part = token.split(".")[1];
  if (!part) return false;
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return claims?.role === "service_role";
  } catch {
    return false;
  }
}

Deno.serve(withSentry("stripe-reports", async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: BROWSER_PREFLIGHT_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = payload.action;

  if (!isServiceRoleToken(req)) {
    const auth = await requireStaff(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    if (auth.staff.role !== "owner") return json({ error: "Not authorized." }, 403);
  }

  if (!stripeConfigured()) return json({ error: "Payments are not configured yet." }, 503);
  const stripe = getStripe()!;

  switch (action) {
    case "overview":
      return await overview(stripe);
    case "payout_detail": {
      const id = (payload.payout_id ?? "").trim();
      if (!/^po_[A-Za-z0-9]+$/.test(id)) return json({ error: "payout_id is required" }, 400);
      return await payoutDetail(stripe, id);
    }
    case "backfill":
      return await backfill(stripe);
    default:
      return json({ error: "Unknown action" }, 400);
  }
}));
