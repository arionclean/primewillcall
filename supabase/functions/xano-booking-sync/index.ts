// Xano -> Supabase one-way booking sync (webhook receiver).
//
// Xano POSTs a booking record (or an array of them) here whenever a booking is
// created or changed. We map it to the new schema using the SAME logic as the
// bulk CSV import (scripts/import_xano_bookings.py) and upsert by legacy_id, so
// re-sending a booking updates it instead of duplicating.
//
// This only ever WRITES to Supabase. It never calls Xano back.
//
// Bookings born in this app reach Xano through the mirror (docs/xano-mirror.md) and
// come back here as an echo. Such a row is recognised by its Xano internal id
// (bookings.xano_internal_id, stamped before Xano was called) and Xano is not the
// source of truth for it, so the echo applies only the two flags staff toggle on
// the Xano side (the iPad check-in, Peek) and never the rest of the record.
//
// Every write this function makes carries the `x-sync-origin: xano` request header,
// which the enqueue_xano_mirror trigger reads to know the write came from Xano and
// must not be mirrored back. That is what keeps the two systems out of a loop.
//
// Auth: send header `x-webhook-secret: <XANO_WEBHOOK_SECRET>` (set that secret on
// the function in Supabase). Deployed with JWT verification off so Xano does not
// need a Supabase token; the shared secret is the guard.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { withSentry } from "../_shared/sentry.ts";
import { xanoGetBookingByInternalId, xanoRowId } from "../_shared/xano-api.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("XANO_WEBHOOK_SECRET") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  global: { headers: { "x-sync-origin": "xano" } },
});

/** A booking this platform created: legacy_id null, or the Groupon mirror's prefix. */
const bornHere = (legacyId: string | null): boolean =>
  legacyId == null || legacyId.startsWith("ota-GP-");

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

type Rec = { business_tour_id: string; business_id: string; tour_id: string };
type Maps = {
  byProduct: Record<string, Rec>;
  byName: Record<string, Rec>;
  byId: Record<string, Rec>;
};

let cache: (Maps & { at: number }) | null = null;

async function tourMap(): Promise<Maps> {
  if (cache && Date.now() - cache.at < 300_000) return cache;
  const { data, error } = await sb
    .from("business_tours")
    .select("id,name,legacy_product_id,business_id,tour_id");
  if (error) throw new Error(`business_tours: ${error.message}`);
  const byProduct: Record<string, Rec> = {};
  const byName: Record<string, Rec> = {};
  const byId: Record<string, Rec> = {};
  for (const r of data ?? []) {
    const rec: Rec = { business_tour_id: r.id, business_id: r.business_id, tour_id: r.tour_id };
    byId[r.id] = rec;
    if (r.legacy_product_id) byProduct[String(r.legacy_product_id)] = rec;
    byName[norm(r.name)] = rec;
  }
  cache = { byProduct, byName, byId, at: Date.now() };
  return cache;
}

/** Direct lookup for a business_tour_id not in the (cached) map. */
async function recForBusinessTour(btid: string): Promise<Rec | null> {
  const { data } = await sb
    .from("business_tours")
    .select("id, business_id, tour_id")
    .eq("id", btid)
    .maybeSingle();
  return data
    ? { business_tour_id: data.id as string, business_id: data.business_id as string, tour_id: data.tour_id as string }
    : null;
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

// An all-digit epoch -> ISO. 10-digit values are treated as SECONDS, 13-digit
// as MILLISECONDS (the boundary 1e12 is year 2001 in ms / year 33658 in s, so
// every realistic date lands on the right side). An instant has no timezone
// ambiguity, which is exactly why a number is the safe thing to pass.
function epochToIso(v: unknown): string | null {
  const s = clean(v);
  if (!s || !/^\d+$/.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n < 1e12) n *= 1000; // seconds -> milliseconds
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// A full ISO-8601 instant WITH a timezone designator (Z or +/-hh:mm). We require
// the offset so a string is never silently read as a local/UTC wall-clock time.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function startsAtOf(row: Record<string, unknown>): string | null {
  // The start instant can arrive as: starts_at (ISO instant, the parser's
  // startsAtUtc) OR starts_at as a bare epoch OR date_timestamp (epoch) OR date
  // (YYYY-MM-DD). The parser already did the NY -> UTC conversion. A human
  // display string like "Jun 30, 2026, 7:00 PM" is rejected (it would otherwise
  // be misread as a UTC wall-clock time and store the wrong hour); send the ISO
  // or the epoch number instead, both of which are unambiguous.
  const direct = clean(row.starts_at);
  if (direct) {
    if (ISO_INSTANT.test(direct)) {
      const dt = new Date(direct);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString();
    }
    const fromEpoch = epochToIso(direct); // accept a bare epoch in starts_at too
    if (fromEpoch) return fromEpoch;
    return null; // present but neither an ISO instant nor an epoch -> error
  }
  const iso = epochToIso(row.date_timestamp);
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
  // Idempotency / dedup key (stored in legacy_id, which is UNIQUE-indexed).
  //
  // The OTA "Product booking ref" is a booking's stable identity and is the SAME
  // value whether the booking reaches us via the email connector or the Xano
  // webhook, so it WINS when present (namespaced `ota-`). OTAs resend the same
  // ref with new statuses; keying on it means a resend UPDATES the one row instead
  // of creating a duplicate. Fallbacks for non-OTA rows: Xano unique_id, then row
  // id. (Native in-app bookings never hit this function, so they need no key.)
  //
  // EXCEPTION: kiosk bookings reuse booking_reference for the CHANNEL constant
  // ('kiosk-sale-card' / 'kiosk-sale-cash'), which is not an identity. Keying on
  // it collapsed every kiosk booking into one endlessly-overwritten row, so a
  // kiosk channel value never keys; those rows key on unique_id (the KS code).
  const refRaw = clean(row.booking_reference);
  const ref = refRaw && !refRaw.toLowerCase().startsWith("kiosk-sale") ? refRaw : null;
  const legacyId =
    (ref ? `ota-${ref}` : null) ??
    clean(row.unique_id) ??
    (clean(row.id) ? `xano-${clean(row.id)}` : null);
  if (!legacyId) {
    return { legacy_id: null, ok: false, error: "need booking_reference, unique_id, or id" };
  }

  const starts = startsAtOf(row);
  if (!starts) {
    return {
      legacy_id: legacyId,
      ok: false,
      error: clean(row.starts_at)
        ? `invalid starts_at: ${clean(row.starts_at)} (send an ISO-8601 UTC instant like 2026-06-30T23:00:00Z, or an epoch like 1782860400000)`
        : "missing start time (send starts_at as an ISO-8601 UTC instant or epoch, or date_timestamp)",
    };
  }

  const checkedRaw = row.checked;
  const checked =
    checkedRaw === true ||
    checkedRaw === 1 ||
    clean(checkedRaw) === "1" ||
    clean(checkedRaw) === "true";
  const checkedAt = checked ? epochToIso(row.check_in_time) ?? starts : null;

  // Where the row lives in Xano, when the payload says. Learned here so an edit made
  // in this app can be sent back to the right Xano row (docs/xano-mirror.md).
  //
  // Two payload shapes reach this function. A full Xano record (the kiosk's
  // dual-write posts Xano's response) carries `internal_id` and `id`. Xano's own
  // trigger, "new platform/sync booking to supabase_v1", sends a NORMALIZED record
  // instead: no `internal_id`, no `id`, no `bookingConfirmation_id`; its `unique_id`
  // is Xano's unique_id when set, else the internal_id. In Xano the two are equal
  // (kiosk) or unique_id is empty, so `unique_id` is the internal id in practice,
  // and the worker verifies it against Xano before relying on it.
  const internalId = clean(row.internal_id) ?? clean(row.unique_id);
  const xanoId = xanoRowId(row);
  const xanoIds = {
    ...(internalId ? { xano_internal_id: internalId } : {}),
    ...(xanoId ? { xano_booking_id: xanoId } : {}),
  };

  // A row we already know: by its Xano internal id first, else by the sync key.
  let existing: Existing | null = null;
  if (internalId) {
    const { data: known, error: knownErr } = await sb
      .from("bookings")
      .select(EXISTING_SELECT)
      .eq("xano_internal_id", internalId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<Existing>();
    if (knownErr) {
      // Falling through would upsert by legacy_id and, for a booking born here,
      // mint a twin. Better to fail the record and let Xano's retry find us.
      return { legacy_id: legacyId, ok: false, error: `lookup by internal id: ${knownErr.message}` };
    }
    if (known && bornHere(known.legacy_id)) {
      // The echo of a booking born here. Xano is not its source of truth: take only
      // what staff toggle on the Xano side, the iPad check-in and Peek, and the row
      // id. A check-in change of ours still waiting to go out wins over the echo.
      const patch: Record<string, unknown> = { ...xanoIds };
      if (typeof row.peek === "boolean") patch.peek = row.peek;
      if (checkedRaw !== undefined && checkedRaw !== null) {
        const guarded = await queuedFields(known.id);
        if (!guarded.has("checked_in_at")) patch.checked_in_at = checkedAt;
      }
      // A balance the guest still owed: the iPad collects it and marks Xano's
      // payment_status "completed". The echo does not carry that field, so while a
      // balance is open, each echo reads the Xano row (one GET, read only) and a
      // completed payment clears the balance here. Our own mirror keeps Xano
      // "pending" until then, so a stale echo cannot clear it early.
      if (known.due_cents > 0) {
        const xanoRow = await xanoGetBookingByInternalId(internalId);
        if (xanoRow.ok && clean(xanoRow.value?.payment_status)?.toLowerCase() === "completed") {
          const guarded = await queuedFields(known.id);
          if (!guarded.has("due")) patch.due_cents = 0;
        }
      }
      const { error } = await sb.from("bookings").update(patch).eq("id", known.id);
      if (error) return { legacy_id: legacyId, ok: false, error: error.message };
      return { legacy_id: legacyId, ok: true };
    }
    existing = known;
  }
  if (!existing) {
    const { data: byKey, error: keyErr } = await sb
      .from("bookings")
      .select(EXISTING_SELECT)
      .eq("legacy_id", legacyId)
      .maybeSingle<Existing>();
    if (keyErr) return { legacy_id: legacyId, ok: false, error: `lookup by legacy id: ${keyErr.message}` };
    existing = byKey;
  }

  // Prefer an already-resolved business_tour_id (e.g. from email-booking-parse);
  // otherwise match by product / supplier / company for raw Xano payloads.
  const btid = clean(row.business_tour_id);
  let rec: Rec | null;
  if (btid) {
    rec = m.byId[btid] ?? (await recForBusinessTour(btid));
    if (!rec) return { legacy_id: legacyId, ok: false, error: "unknown business_tour_id" };
  } else {
    rec = resolveTour(row, m);
    if (!rec) return { legacy_id: legacyId, ok: false, error: "could not resolve tour" };
  }

  const name = parseName(row);
  const incomingPhone = clean(row.phone);

  let a = toInt(row.adult);
  const c = toInt(row.child);
  const inf = toInt(row.infant);
  if (a + c + inf === 0) a = toInt(row.paxs);

  const startMs = new Date(starts).getTime();
  const status = STATUS_MAP[(clean(row.status) ?? "").toLowerCase()] ?? "confirmed";

  // Xano's bookingConfirmation_id is the token in the booking link the guest was
  // emailed (bked.io/booking/<token>). Carrying it into public_token keeps those
  // links working on this app's /booking page after cutover. When absent, the
  // column's default generates a token on insert (and an update leaves the
  // existing one untouched, since the key is omitted from the payload).
  const confirmationToken = clean(row.bookingConfirmation_id);

  if (existing) {
    // A booking we already hold. Xano owns its status, time, pax, check-in, reference
    // and channel, and those are taken. It does NOT own which business's copy of the
    // tour the booking sits on, the guest row, the price or the pax breakdown: the
    // old blanket upsert rewrote all of those on every echo, which moved bookings
    // between businesses (they vanished from that desk's screen), minted guest
    // twins and zeroed totals. A field with a change of ours still queued for Xano
    // is left alone too, so a slow send never loses an edit (docs/xano-mirror.md).
    const guarded = await queuedFields(existing.id);
    const patch: Record<string, unknown> = {
      ...xanoIds,
      legacy_id: legacyId,
      legacy_reference: clean(row.booking_reference) ?? existing.legacy_reference,
    };
    const channel = clean(row.booking_channel);
    if (channel) patch.source_channel = channel;
    if (!guarded.has("status")) patch.status = status;
    if (!guarded.has("starts_at") && startMs !== new Date(existing.starts_at).getTime()) {
      // Keep the booking's own duration: the tour's, not a fixed 90 minutes.
      const duration = new Date(existing.ends_at).getTime() - new Date(existing.starts_at).getTime();
      patch.starts_at = starts;
      patch.ends_at = new Date(startMs + (duration > 0 ? duration : 90 * 60 * 1000)).toISOString();
    }
    if (!guarded.has("pax")) {
      patch.pax_adult = a;
      patch.pax_child = c;
      patch.pax_infant = inf;
    }
    if (!guarded.has("checked_in_at") && checkedRaw !== undefined && checkedRaw !== null) {
      patch.checked_in_at = checkedAt;
    }
    // A real product change (a different master tour) moves the booking, and it
    // stays on this business's own copy of the new tour when there is one.
    if (!guarded.has("business_tour_id") && rec.tour_id !== existing.business_tour?.tour_id) {
      const { data: own } = await sb
        .from("business_tours")
        .select("id")
        .eq("business_id", existing.business_id)
        .eq("tour_id", rec.tour_id)
        .maybeSingle<{ id: string }>();
      patch.business_tour_id = own?.id ?? rec.business_tour_id;
      patch.business_id = own ? existing.business_id : rec.business_id;
    }
    // Xano has a phone we lack (the email connector filled it in later): take it.
    // Never a new guest row.
    if (norm(incomingPhone) && !norm(existing.customer?.phone)) {
      await sb.from("customers").update({ phone: incomingPhone }).eq("id", existing.customer_id);
    }
    if (confirmationToken) patch.public_token = confirmationToken;
    if (typeof row.peek === "boolean") patch.peek = row.peek;
    if (Array.isArray(row.image_url)) patch.groupon_voucher_urls = imageUrls(row.image_url);

    const { error } = await sb.from("bookings").update(patch).eq("id", existing.id);
    if (error) return { legacy_id: legacyId, ok: false, error: error.message };
    return { legacy_id: legacyId, ok: true };
  }

  // A booking we have never seen: the full record.
  const customerId = await findOrCreateCustomer(
    rec.business_id,
    name,
    incomingPhone,
    clean(row.email),
  );

  const ends = new Date(startMs + 90 * 60 * 1000).toISOString();

  const price = clean(row.price);
  let totalCents = 0;
  if (price) {
    const f = Number(price);
    if (Number.isFinite(f)) totalCents = Math.round(f * 100);
  }

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
    ...xanoIds,
    ...(confirmationToken ? { public_token: confirmationToken } : {}),
    ...(typeof row.peek === "boolean" ? { peek: row.peek } : {}),
    ...(Array.isArray(row.image_url)
      ? { groupon_voucher_urls: imageUrls(row.image_url) }
      : {}),
  };

  // Upsert, not insert: two deliveries of a new booking can race, and the second
  // must land on the first one's row.
  const { error } = await sb
    .from("bookings")
    .upsert(payload, { onConflict: "legacy_id" });
  if (error) return { legacy_id: legacyId, ok: false, error: error.message };
  return { legacy_id: legacyId, ok: true };
}

/** What we hold for a booking Xano is telling us about. */
const EXISTING_SELECT =
  "id, legacy_id, legacy_reference, business_id, business_tour_id, customer_id, starts_at, ends_at, " +
  "due_cents, business_tour:business_tours(tour_id), customer:customers(phone)";

interface Existing {
  id: string;
  legacy_id: string | null;
  legacy_reference: string | null;
  business_id: string;
  business_tour_id: string;
  customer_id: string;
  starts_at: string;
  ends_at: string;
  due_cents: number;
  business_tour: { tour_id: string } | null;
  customer: { phone: string | null } | null;
}

/**
 * The mirrored fields of a booking with a change of ours still on its way to Xano
 * (docs/xano-mirror.md). The echo must not overwrite those: the worker sends the
 * booking's current state, so the echo would revert the edit and the send would
 * then carry the reverted value.
 */
async function queuedFields(bookingId: string): Promise<Set<string>> {
  const { data } = await sb
    .from("xano_mirror_queue")
    .select("fields")
    .eq("booking_id", bookingId)
    .in("status", ["pending", "sending"]);
  return new Set((data ?? []).flatMap((q: { fields: string[] }) => q.fields));
}

// Xano image fields arrive as an array of URL strings or of file objects with
// a `url` property; normalize to plain URL strings.
function imageUrls(arr: unknown[]): string[] {
  const urls: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) {
      urls.push(item.trim());
    } else if (item && typeof item === "object") {
      const u = clean((item as Record<string, unknown>).url);
      if (u) urls.push(u);
    }
  }
  return urls;
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(withSentry("xano-booking-sync", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!WEBHOOK_SECRET) {
    return json({ error: "server not configured: set XANO_WEBHOOK_SECRET" }, 503);
  }
  if ((req.headers.get("x-webhook-secret") ?? "") !== WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  // Accept a JSON body (single record or array) OR query-string fields (a single
  // record), so the caller can POST either way.
  let rows: unknown[];
  const raw = await req.text();
  if (raw && raw.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    rows = Array.isArray(body) ? body : [body];
  } else {
    const params = new URL(req.url).searchParams;
    if ([...params.keys()].length === 0) {
      return json({ error: "empty body" }, 400);
    }
    const row: Record<string, string> = {};
    for (const [k, v] of params) row[k] = v;
    rows = [row];
  }
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

  // Self-heal the payments ledger: a kiosk Stripe charge can land BEFORE its
  // booking syncs, leaving the charge without customer_name / booking_id. Now
  // that these bookings exist, backfill any charge referencing them (KS ref =
  // legacy_id). Best-effort: a heal failure never fails the sync.
  let healed = 0;
  const okRefs = results.flatMap((r) => (r.ok && r.legacy_id ? [r.legacy_id] : []));
  if (okRefs.length > 0) {
    try {
      const { data } = await sb.rpc("heal_ledger_booking_links", { p_refs: okRefs });
      healed = typeof data === "number" ? data : 0;
    } catch {
      // ignore; the next sync or a manual heal sweeps it
    }
  }

  return json(
    {
      ok: true,
      processed: results.length,
      upserted,
      failed: results.length - upserted,
      healed,
      results,
    },
    200,
  );
}));
