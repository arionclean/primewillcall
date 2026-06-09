// Xano -> Supabase one-way booking sync (webhook receiver).
//
// Xano POSTs a booking record (or an array of them) here whenever a booking is
// created or changed. We map it to the new schema using the SAME logic as the
// bulk CSV import (scripts/import_xano_bookings.py) and upsert by legacy_id, so
// re-sending a booking updates it instead of duplicating.
//
// This only ever WRITES to Supabase. It never calls Xano back. Bookings created
// natively in this app have no legacy_id and are never touched by the sync.
//
// Auth: send header `x-webhook-secret: <XANO_WEBHOOK_SECRET>` (set that secret on
// the function in Supabase). Deployed with JWT verification off so Xano does not
// need a Supabase token; the shared secret is the guard.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("XANO_WEBHOOK_SECRET") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── helpers (ported from the import script) ───────────────────────────────────
const norm = (s: unknown): string =>
  (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "");

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s.toLowerCase() === "null" ? null : s;
};

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};

// messy supplier/channel names -> tour name (curated from the data)
const ALIASES: Record<string, string> = {
  miamiskylinecruises: "miamiskylinecruises",
  miamistarislandcruises: "miamiskylinecruises",
  starislandcruises: "miamiskylinecruises",
  miamisunsetboatcruises: "miamiskylinecruises",
  miamisunsetboat: "miamiskylinecruises",
  miamibaysideboattour: "miamiskylinecruises",
  miamibaysideboattourwebsite: "miamiskylinecruises",
  miamicelebrityboattours: "miamiskylinecruises",
  miamiboattours: "miamiskylinecruises",
  miamisightseeingboattours: "miamiskylinecruises",
  miamistarisland: "miamiskylinecruises",
  miamitourbus: "miami5in1citytour",
  keywestsightseeingtours: "keywestdaytrips",
  keywest: "keywestdaytrips",
};
// company (Bubble id) -> flagship tour name, last-resort fallback
const COMPANY_DEFAULT: Record<string, string> = {
  "1712894857551x926333421634977800": "miamiskylinecruises",
  "1712896100693x988159247184035800": "keywestdaytrips",
};
const DEFAULT_TOUR_NAME = "miamiskylinecruises";
const STATUS_MAP: Record<string, string> = {
  confirmed: "confirmed",
  canceled: "cancelled",
  cancelled: "cancelled",
  pending: "pending",
};

type Rec = { business_tour_id: string; business_id: string };
type Maps = { byProduct: Record<string, Rec>; byName: Record<string, Rec> };

let cache: (Maps & { at: number }) | null = null;

async function tourMap(): Promise<Maps> {
  if (cache && Date.now() - cache.at < 300_000) return cache;
  const { data, error } = await sb
    .from("business_tours")
    .select("id,name,legacy_product_id,business_id");
  if (error) throw new Error(`business_tours: ${error.message}`);
  const byProduct: Record<string, Rec> = {};
  const byName: Record<string, Rec> = {};
  for (const r of data ?? []) {
    const rec: Rec = { business_tour_id: r.id, business_id: r.business_id };
    if (r.legacy_product_id) byProduct[String(r.legacy_product_id)] = rec;
    byName[norm(r.name)] = rec;
  }
  cache = { byProduct, byName, at: Date.now() };
  return cache;
}

function resolveTour(row: Record<string, unknown>, m: Maps): Rec | null {
  const p = clean(row.product);
  if (p && m.byProduct[p]) return m.byProduct[p];
  for (const f of ["supplier", "booking_channel"]) {
    const key = norm(row[f]);
    if (key && m.byName[key]) return m.byName[key];
    if (key && ALIASES[key] && m.byName[ALIASES[key]]) return m.byName[ALIASES[key]];
  }
  const comp = clean(row.company);
  const tgt = COMPANY_DEFAULT[comp ?? ""] ?? DEFAULT_TOUR_NAME;
  return m.byName[tgt] ?? null;
}

function parseName(row: Record<string, unknown>): string {
  const cn = clean(row.customer_name);
  if (cn) {
    if (cn.includes(",")) {
      const idx = cn.indexOf(",");
      const last = cn.slice(0, idx).trim();
      const first = cn.slice(idx + 1).trim();
      const full = `${first} ${last}`.trim();
      if (full) return full;
    }
    return cn;
  }
  const parts = [clean(row.Fname), clean(row.Lname)].filter(Boolean);
  return parts.join(" ") || "Guest";
}

function epochIso(ms: unknown): string | null {
  const s = clean(ms);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n); // epoch ms
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function startsAtOf(row: Record<string, unknown>): string | null {
  const iso = epochIso(row.date_timestamp);
  if (iso) return iso;
  const d = clean(row.date);
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T12:00:00.000Z`;
  return null;
}

async function findOrCreateCustomer(
  businessId: string,
  name: string,
  phone: string | null,
  email: string | null,
): Promise<string> {
  const phoneDigits = norm(phone);
  const nameNorm = norm(name);
  const esc = name.replace(/[%_\\]/g, (m) => "\\" + m);
  const { data: cands } = await sb
    .from("customers")
    .select("id, full_name, phone")
    .eq("business_id", businessId)
    .ilike("full_name", esc)
    .limit(50);
  for (const c of cands ?? []) {
    if (norm(c.full_name) === nameNorm && norm(c.phone) === phoneDigits) {
      return c.id as string;
    }
  }
  const { data: ins, error } = await sb
    .from("customers")
    .insert({
      business_id: businessId,
      full_name: name,
      phone,
      email,
      legacy_source: "xano",
    })
    .select("id")
    .single();
  if (error) throw new Error(`customer insert: ${error.message}`);
  return ins!.id as string;
}

type Result = { legacy_id: string | null; ok: boolean; error?: string };

async function ingest(row: Record<string, unknown>, m: Maps): Promise<Result> {
  const legacyId =
    clean(row.unique_id) ?? (clean(row.id) ? `xano-${clean(row.id)}` : null);
  if (!legacyId) return { legacy_id: null, ok: false, error: "missing legacy id" };

  const starts = startsAtOf(row);
  if (!starts) return { legacy_id: legacyId, ok: false, error: "missing start time" };

  const rec = resolveTour(row, m);
  if (!rec) return { legacy_id: legacyId, ok: false, error: "could not resolve tour" };

  const name = parseName(row);
  const customerId = await findOrCreateCustomer(
    rec.business_id,
    name,
    clean(row.phone),
    clean(row.email),
  );

  let a = toInt(row.adult);
  const c = toInt(row.child);
  const inf = toInt(row.infant);
  if (a + c + inf === 0) a = toInt(row.paxs);

  const startMs = new Date(starts).getTime();
  const ends = new Date(startMs + 90 * 60 * 1000).toISOString();

  const checkedRaw = row.checked;
  const checked =
    checkedRaw === true ||
    checkedRaw === 1 ||
    clean(checkedRaw) === "1" ||
    clean(checkedRaw) === "true";
  const checkedAt = checked ? epochIso(row.check_in_time) ?? starts : null;

  const price = clean(row.price);
  let totalCents = 0;
  if (price) {
    const f = Number(price);
    if (Number.isFinite(f)) totalCents = Math.round(f * 100);
  }

  const status = STATUS_MAP[(clean(row.status) ?? "").toLowerCase()] ?? "confirmed";

  const payload = {
    business_id: rec.business_id,
    business_tour_id: rec.business_tour_id,
    customer_id: customerId,
    starts_at: starts,
    ends_at: ends,
    status,
    total_cents: totalCents,
    currency: "usd",
    pax_adult: a,
    pax_child: c,
    pax_infant: inf,
    tour_pax_breakdown: [],
    checked_in_at: checkedAt,
    legacy_id: legacyId,
    legacy_reference: clean(row.booking_reference),
    source_channel: clean(row.booking_channel),
  };

  const { error } = await sb
    .from("bookings")
    .upsert(payload, { onConflict: "legacy_id" });
  if (error) return { legacy_id: legacyId, ok: false, error: error.message };
  return { legacy_id: legacyId, ok: true };
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!WEBHOOK_SECRET) {
    return json({ error: "server not configured: set XANO_WEBHOOK_SECRET" }, 503);
  }
  if ((req.headers.get("x-webhook-secret") ?? "") !== WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const rows = Array.isArray(body) ? body : [body];
  if (rows.length === 0) return json({ error: "empty body" }, 400);
  if (rows.length > 500) return json({ error: "max 500 records per call" }, 413);

  let m: Maps;
  try {
    m = await tourMap();
  } catch (e) {
    return json({ error: `tour map load failed: ${String(e)}` }, 500);
  }

  const results: Result[] = [];
  for (const r of rows) {
    try {
      results.push(await ingest(r as Record<string, unknown>, m));
    } catch (e) {
      results.push({ legacy_id: null, ok: false, error: String(e) });
    }
  }
  const upserted = results.filter((r) => r.ok).length;
  return json(
    { ok: true, processed: results.length, upserted, failed: results.length - upserted, results },
    200,
  );
});
