// Cash sales the tablet told Xano about and never told us. pg_cron calls this.
//
// Why it exists. A cash sale is written by the tablet in two independent calls, one
// to Xano and one to us, and neither waits for the other. Nothing retries the second
// one. On 2026-09-10 a $40 sale on kiosk3 reached Xano and never reached us: there is
// no request in our logs at all, so it was not a failure we could see, it was a call
// that never went out. The kiosk's own Sales screen then showed $701 where Xano showed
// $741, and the only way to notice was to compare the two by hand.
//
// Card sales on flow v2 do not have this problem, because there the SERVER writes both
// sides and kiosk-sale-sweep retries the Xano half. Cash still uses the tablet's two
// calls on every kiosk and every build, so it needs the mirror image of that safety
// net: read what Xano has and import what we are missing.
//
// This is the live version of scripts/reconcile_kiosk_sales.py, which found these by
// hand. Xano is only ever READ (the same public endpoint the tablet's own Sales screen
// uses), never written.
//
// Idempotent. Every imported row carries dedup_key "xano-cash:<xano id>", unique in the
// table, so a second pass writes nothing. The tablet's own key looks like
// "KS-ABC123:cash", so the two can never collide, and a sale the tablet did deliver is
// left alone.
//
// Scope: today and yesterday in New York, every kiosk that has a Xano id. A sale older
// than that is the reconcile script's job, not a live sweep's.
//
// Auth: x-cron-secret must equal CRON_SECRET, like the other cron functions.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { withSentry } from "../_shared/sentry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const XANO_CASH_SALES = "https://xmhi-aj9d-cnsb.n7.xano.io/api:_o9979qq/cash_sales";
const XANO_TIMEOUT_MS = 15_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The New York calendar day, `n` days back, in the words Xano's endpoint expects. */
function nyDay(daysBack: number): { key: string; label: string } {
  const at = new Date(Date.now() - daysBack * 86_400_000);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  return { key: `${y}-${get("month")}-${get("day")}`, label: `${MONTHS[m - 1]} ${d} ${y}` };
}

/** Xano stores the amount as text dollars ("40", "64.20"). Round through a string so
 *  64.20 cannot land on 6419. */
function cents(amount: unknown): number | null {
  const n = Number(String(amount ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

type XanoSale = {
  id: number;
  amount: string;
  type: string | null;
  product: string | null;
  status: string | null;
  created_at: number | null;
  booking_single?: { internal_id?: string | null } | null;
};

Deno.serve(withSentry("kiosk-cash-sweep", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: kiosks, error: kioskErr } = await sb
    .from("kiosks")
    .select("id, slug, business_id, xano_kiosk_id")
    .not("xano_kiosk_id", "is", null);
  if (kioskErr) return json({ error: "kiosks", message: kioskErr.message }, 500);

  const days = [nyDay(0), nyDay(1)];
  const counts = { scanned: 0, imported: 0, errors: 0 };
  // What was imported, not just how many: a run that quietly fixes a till should
  // say which sale it fixed.
  const details: string[] = [];

  // Every kiosk-day at once. Ten sequential Xano reads took longer than the caller
  // was willing to wait; in parallel the whole sweep costs one round trip.
  const pulls = await Promise.all(
    (kiosks ?? [])
      .filter((k) => k.business_id && k.slug)
      .flatMap((kiosk) =>
        days.map(async (day) => {
          try {
            const url = `${XANO_CASH_SALES}?${new URLSearchParams({
              date: day.label,
              kiosk: String(kiosk.xano_kiosk_id),
            })}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(XANO_TIMEOUT_MS) });
            if (!res.ok) return { kiosk, sales: null };
            const body = await res.json();
            return { kiosk, sales: (Array.isArray(body?.sales) ? body.sales : []) as XanoSale[] };
          } catch {
            return { kiosk, sales: null };
          }
        }),
      ),
  );

  for (const pull of pulls) {
    const kiosk = pull.kiosk;
    if (pull.sales === null) {
      counts.errors++;
      continue;
    }
    {
      const sales = pull.sales;
      for (const sale of sales) {
        counts.scanned++;
        if ((sale.status ?? "success") !== "success") continue;
        const amountCents = cents(sale.amount);
        if (!amountCents) continue;

        const dedupKey = `xano-cash:${sale.id}`;
        const { data: seen } = await sb
          .from("cash_sales")
          .select("id")
          .eq("dedup_key", dedupKey)
          .maybeSingle();
        if (seen) continue;

        // The tablet's own row for the same sale, if it did arrive: same kiosk, same
        // amount, same tender, same day. Its key is the booking code, not ours, so
        // dedup_key alone would not find it.
        const ref = String(sale.booking_single?.internal_id ?? "").trim() || null;
        const tender = (sale.type ?? "cash").toLowerCase() === "card" ? "card" : "cash";
        if (ref) {
          const { data: byRef } = await sb
            .from("cash_sales")
            .select("id")
            .eq("kiosk_slug", kiosk.slug)
            .eq("booking_ref", ref)
            .eq("type", tender)
            .eq("amount_cents", amountCents)
            .limit(1);
          if (byRef && byRef.length > 0) continue;
        }

        // The booking is usually already here (the tablet's booking call is separate
        // from its sale call, and it is the sale call that goes missing).
        let bookingId: string | null = null;
        if (ref) {
          const { data: booking } = await sb
            .from("bookings")
            .select("id")
            .or(`legacy_id.eq.${ref},xano_internal_id.eq.${ref}`)
            .limit(1)
            .maybeSingle();
          bookingId = booking?.id ?? null;
        }

        const { error } = await sb.from("cash_sales").insert({
          business_id: kiosk.business_id,
          kiosk_id: kiosk.id,
          kiosk_slug: kiosk.slug,
          booking_id: bookingId,
          booking_ref: ref,
          amount_cents: amountCents,
          type: tender,
          product: sale.product || "ticket",
          status: "success",
          source: "kiosk",
          dedup_key: dedupKey,
          ...(sale.created_at ? { created_at: new Date(sale.created_at).toISOString() } : {}),
        });
        if (error) {
          counts.errors++;
          continue;
        }
        counts.imported++;
        details.push(`${kiosk.slug} ${ref ?? "?"} ${tender} ${amountCents}`);
      }
    }
  }

  return json({ ok: true, ...counts, details }, 200);
}));
