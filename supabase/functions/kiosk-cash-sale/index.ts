// Kiosk sale ledger write for the PrimeKiosk tablet (Xano -> Supabase migration).
//
// Records a kiosk sale (cash OR card; the `type` field distinguishes) into cash_sales.
// Supabase-native replacement for the Xano `cash_sales` POST endpoint. Public + optional
// KIOSK_SHARED_SECRET, service role (bypasses RLS to write the ledger). No Xano sync mirrors
// cash sales, so the app is the sole writer; a per-sale idempotency key + upsert on dedup_key
// means a retried shadow write can never double-insert.
//
// Body: { kiosk, booking_id?, amount_cents? | amount?, type?, product?, status?, idempotency_key?,
//         employee_id? }
//   `kiosk` is kiosks.slug (the tablet's login username). `amount_cents` wins; else `amount` is
//   parsed as a dollar value (accepts "$1,234.50", "1234.5", 1234.5). `employee_id` is the
//   kiosk employee (PIN) who recorded it, stored when it checks out, ignored otherwise.
//
// Secrets: optional KIOSK_SHARED_SECRET. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are provided.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveEmployee } from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KIOSK_SHARED_SECRET = Deno.env.get("KIOSK_SHARED_SECRET") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** amount_cents wins; otherwise parse a dollar amount that may be "$1,234.50" / "1234.5" / 1234.5. */
function toCents(body: { amount_cents?: unknown; amount?: unknown }): number {
  const cents = Math.floor(Number(body.amount_cents));
  if (Number.isFinite(cents) && cents > 0) return cents;
  const raw = body.amount;
  if (raw === null || raw === undefined) return 0;
  const dollars = Number(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
}

Deno.serve(withSentry("kiosk-cash-sale", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (KIOSK_SHARED_SECRET && req.headers.get("x-kiosk-secret") !== KIOSK_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: {
    kiosk?: string;
    booking_id?: string;
    amount_cents?: number;
    amount?: string | number;
    type?: string;
    product?: string;
    status?: string;
    idempotency_key?: string;
    employee_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const kiosk = String(body.kiosk ?? "").trim();
  if (!kiosk) return json({ error: "missing_kiosk" }, 400);

  const amountCents = toCents(body);
  if (amountCents <= 0) return json({ error: "bad_amount" }, 400);

  // Resolve the kiosk -> business + kiosk row (service role; the app has no Supabase session).
  const { data: kioskRow } = await sb
    .from("kiosks")
    .select("id, business_id")
    .eq("slug", kiosk)
    .maybeSingle();
  if (!kioskRow?.business_id) return json({ error: "unknown_kiosk" }, 404);

  const bookingRef = String(body.booking_id ?? "").trim() || null;
  const type = String(body.type ?? "cash").trim() || "cash";
  const dedupKey =
    String(body.idempotency_key ?? "").trim() ||
    (bookingRef ? `${kiosk}:${bookingRef}:${type}:${amountCents}` : null);
  const employee = await resolveEmployee(sb, body.employee_id);

  const row = {
    business_id: kioskRow.business_id,
    kiosk_id: kioskRow.id,
    booking_ref: bookingRef,
    amount_cents: amountCents,
    type,
    product: String(body.product ?? "").trim() || null,
    status: String(body.status ?? "success").trim() || "success",
    source: "kiosk",
    kiosk_slug: kiosk,
    dedup_key: dedupKey,
    ...(employee ? { employee_id: employee.id } : {}),
  };

  // Upsert on dedup_key when present so a retry cannot double-insert; else a plain insert.
  const q = dedupKey
    ? sb.from("cash_sales").upsert(row, { onConflict: "dedup_key" })
    : sb.from("cash_sales").insert(row);
  const { data, error } = await q.select("id").single();
  if (error) return json({ error: "insert_failed", message: error.message }, 500);

  return json({ ok: true, id: data?.id ?? null }, 200);
}));
