// The three things a tablet READS, answered from this platform instead of Xano:
// the product list, the day's bookings, and the day's sales.
//
// Each answer is in the exact shape the tablet's screen has always consumed from
// the Xano endpoint it replaces, so the screens change nothing but the URL and a
// kiosk can be moved over (and back) with kiosks.read_source, no reinstall. The
// shapes were taken from the Xano definitions, not guessed:
//
//   products  <- api:bzzXiLA1/products        (every product, Skyline first)
//   bookings  <- api:2k2IsvEZ/querry_all      (the New York day, every business,
//                                              EXCEPT the Key West Day Trip product,
//                                              cancelled ones included, grouped by
//                                              departure, guests = adults + children)
//   sales     <- api:_o9979qq/cash_sales      (this kiosk, the New York day, newest
//                                              first, the booking attached)
//
// Two things are deliberately better than Xano's answer, both already agreed:
// a refunded card sale nets to what was kept (Xano drops the row), and a
// cancelled booking's sale still counts (the money was taken).
//
// Identity on the way out is Xano's, because the tablet still WRITES to Xano
// while it reads from here: a booking's `id` is its Xano row id, `internal_id`
// its Xano code, `product` the Xano product id (tours.legacy_product_id). A
// booking not yet mirrored to Xano has no row id and gets 0; the tablet's own
// write for it goes through kiosk-booking-update by code and date regardless.
//
// Public like the other kiosk functions (JWT off); optional KIOSK_SHARED_SECRET.
// Body: { kiosk, action: 'products' | 'bookings' | 'sales', date?, app_build?, device_id? }
// `date` as the tablet sends it ("Sep 9 2026") or ISO "2026-09-09"; today when absent.

import {
  json,
  kioskAuthorized,
  resolveKiosk,
  serviceClient,
} from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const NY = "America/New_York";
/** Xano's product id for the Key West Day Trip, which the tablet's manifest has never shown. */
const KEY_WEST_DAY_TRIP = "1733296384794x165710027724423170";

type Action = "products" | "bookings" | "sales";

interface Body {
  kiosk?: string;
  action?: Action;
  date?: string;
  app_build?: string;
  device_id?: string;
}

// ── dates ─────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The New York calendar day the tablet means, as YYYY-MM-DD. */
function dayOf(input: string | undefined): string | null {
  const s = (input ?? "").trim();
  if (!s) return nyParts(new Date()).ymd;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/** UTC instants for [00:00, 24:00) of a New York day, DST-correct. */
function nyDayRange(ymd: string): { start: Date; end: Date } {
  const [y, mo, d] = ymd.split("-").map(Number);
  const start = nyLocalToUtc(y, mo, d, 0, 0, 0);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = nyLocalToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0);
  return { start, end };
}

function nyLocalToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  // Guess UTC, read back what New York shows, correct by the difference. Two passes
  // settle a DST edge.
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const p = nyParts(new Date(guess));
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const want = Date.UTC(y, mo - 1, d, h, mi, s);
    guess += want - shown;
  }
  return new Date(guess);
}

function nyParts(at: Date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const g: Record<string, string> = {};
  for (const part of f.formatToParts(at)) g[part.type] = part.value;
  const y = Number(g.year), mo = Number(g.month), d = Number(g.day);
  return {
    y, mo, d, h: Number(g.hour), mi: Number(g.minute), s: Number(g.second),
    ymd: `${g.year}-${g.month}-${g.day}`,
  };
}

/**
 * "Sep 9, 2026 6:30 PM", the group label Xano's querry_all produces (date-fns
 * 'MMM d, yyyy h:mm a'). Built from parts rather than one format call because
 * Intl puts a second comma before the time and the tablet keys its slot list on
 * this exact string.
 */
function nyDisplay(at: Date): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const g: Record<string, string> = {};
  for (const part of f.formatToParts(at)) g[part.type] = part.value;
  return `${g.month} ${g.day}, ${g.year} ${g.hour}:${g.minute} ${g.dayPeriod}`;
}

/** "10:30 AM", the timeslot label the tablet's pickers show. */
function slotLabel(time: string): string {
  const [hh, mm] = time.split(":").map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

// ── products ──────────────────────────────────────────────────────────────────

/** The short names the tablet colours its product chips by (from Xano's rows). */
function shortName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("skyline")) return "Skyline";
  if (n.includes("mojito")) return "Boat+Mojito";
  if (n.includes("empanada")) return "Boat+Empanada";
  if (/5\s*in\s*1/.test(n)) return "5 in 1";
  if (n.includes("combo")) return "Combo";
  if (n.includes("key west")) return "Key West";
  if (n.includes("party")) return "Party";
  if (n.includes("transport")) return "Transport";
  if (n.includes("everglades")) return "Everglades";
  if (n.includes("jet ski")) return "Jet Ski";
  return name.slice(0, 12);
}

/** Xano's ordering: Skyline, then Boat + Mojito, 5 in 1, combo, everything else. */
function priority(name: string): number {
  const n = name.toLowerCase().replace(/\s+/g, " ");
  if (n.includes("miami skyline")) return 1;
  if (n.includes("boat + mojito")) return 2;
  if (/(^| )5(\s|-)*in(\s|-)*1( |$)/.test(n)) return 3;
  if (n.includes("combo")) return 4;
  return 5;
}

/** Our tier labels in the words the tablet looks prices up by. */
function tierType(label: string): string {
  const l = label.trim().toLowerCase();
  return l === "infant" ? "free child" : l;
}

interface TourRow {
  id: string;
  name: string;
  capacity: number | null;
  legacy_product_id: string | null;
  tour_timeslots: { start_time: string; is_active: boolean; sort_order: number | null }[];
}
interface BusinessTourRow {
  id: string;
  name: string | null;
  legacy_product_id: string | null;
  tour: TourRow | null;
  tour_pax_tiers: { label: string; price_cents: number; is_active: boolean; sort_order: number | null }[];
}

async function products(sb: ReturnType<typeof serviceClient>, businessId: string) {
  const { data, error } = await sb
    .from("business_tours")
    .select(
      "id, name, legacy_product_id, tour:tours(id, name, capacity, legacy_product_id, tour_timeslots(start_time, is_active, sort_order)), tour_pax_tiers(label, price_cents, is_active, sort_order)",
    )
    .eq("business_id", businessId)
    .eq("is_active", true)
    .returns<BusinessTourRow[]>();
  if (error) return { error: error.message };

  const rows = (data ?? [])
    .filter((r) => r.tour)
    .map((r) => {
      const t = r.tour!;
      const name = r.name || t.name;
      return {
        internal_id: r.legacy_product_id ?? t.legacy_product_id ?? r.id,
        product_name: name,
        short_name: shortName(name),
        price: (r.tour_pax_tiers ?? [])
          .filter((p) => p.is_active)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((p) => ({ type: tierType(p.label), price: p.price_cents / 100 })),
        timeslots: (t.tour_timeslots ?? [])
          .filter((s) => s.is_active)
          .sort((a, b) => a.start_time.localeCompare(b.start_time))
          .map((s) => ({ timeslot_name: slotLabel(s.start_time), capacity: t.capacity ?? 100 })),
        company: businessId,
        company_id: businessId,
        _priority: priority(name),
      };
    })
    .sort((a, b) => a._priority - b._priority || a.product_name.localeCompare(b.product_name))
    .map(({ _priority: _p, ...rest }, i) => ({ id: i + 1, ...rest }));
  return { products: rows };
}

// ── bookings ──────────────────────────────────────────────────────────────────

interface BookingRow {
  id: string;
  starts_at: string;
  status: string;
  pax_adult: number;
  pax_child: number;
  pax_infant: number;
  total_cents: number;
  due_cents: number;
  notes: string | null;
  checked_in_at: string | null;
  public_token: string | null;
  legacy_id: string | null;
  legacy_reference: string | null;
  xano_internal_id: string | null;
  xano_booking_id: number | null;
  source_channel: string | null;
  peek: boolean | null;
  business_id: string;
  customer: { full_name: string | null; phone: string | null; email: string | null } | null;
  business_tour: {
    name: string | null;
    legacy_product_id: string | null;
    tour: { name: string; legacy_product_id: string | null } | null;
  } | null;
}

const BOOKING_SELECT =
  "id, starts_at, status, pax_adult, pax_child, pax_infant, total_cents, due_cents, notes, checked_in_at, " +
  "public_token, legacy_id, legacy_reference, xano_internal_id, xano_booking_id, source_channel, peek, business_id, " +
  "customer:customers(full_name, phone, email), " +
  "business_tour:business_tours(name, legacy_product_id, tour:tours(name, legacy_product_id))";

function xanoStatus(status: string): string {
  // Xano's own spelling. The tablet strikes a row through on "canceled".
  return status === "cancelled" ? "canceled" : status;
}

function splitName(full: string | null): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** One booking in the shape querry_all hands the tablet. */
function toXanoBooking(b: BookingRow) {
  const at = new Date(b.starts_at);
  const productId = b.business_tour?.legacy_product_id ?? b.business_tour?.tour?.legacy_product_id ?? null;
  const name = splitName(b.customer?.full_name ?? null);
  return {
    id: b.xano_booking_id ?? 0,
    internal_id: b.xano_internal_id ?? b.legacy_id ?? b.public_token ?? b.id,
    bookingConfirmation_id: b.public_token,
    booking_reference: b.legacy_reference ?? "",
    booking_channel: b.source_channel ?? "",
    customer_name: b.customer?.full_name ?? "Guest",
    Fname: name.first,
    Lname: name.last,
    phone: b.customer?.phone ?? null,
    email: b.customer?.email ?? null,
    adult: b.pax_adult,
    child: b.pax_child,
    infant: b.pax_infant,
    // querry_all counts adults + children; infants never counted on that screen.
    paxs: b.pax_adult + b.pax_child,
    checked: b.checked_in_at != null,
    status: xanoStatus(b.status),
    product: productId,
    product_var: b.business_tour?.name ?? b.business_tour?.tour?.name ?? null,
    price: b.total_cents,
    payment_status: b.due_cents > 0 ? "pending" : "completed",
    payment_qr: null,
    date: nyParts(at).ymd,
    date_timestamp: at.getTime(),
    note: b.notes,
    company: b.business_id,
    peek: b.peek ?? false,
    _sb_id: b.id,
  };
}

async function bookings(sb: ReturnType<typeof serviceClient>, ymd: string) {
  const { start, end } = nyDayRange(ymd);
  const { data, error } = await sb
    .from("bookings")
    .select(BOOKING_SELECT)
    .gte("starts_at", start.toISOString())
    .lt("starts_at", end.toISOString())
    .eq("awaiting_payment", false)
    .order("starts_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(2000)
    .returns<BookingRow[]>();
  if (error) return { error: error.message };

  const groups: { display_date: string; date: number; bookings: ReturnType<typeof toXanoBooking>[] }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const b of data ?? []) {
    const x = toXanoBooking(b);
    if (x.product === KEY_WEST_DAY_TRIP) continue; // never on the manifest, same as Xano
    const key = nyDisplay(new Date(b.starts_at));
    let g = byKey.get(key);
    if (!g) {
      g = { display_date: key, date: x.date_timestamp, bookings: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.bookings.push(x);
  }
  return { bookings: groups };
}

// ── sales ─────────────────────────────────────────────────────────────────────

interface SaleRow {
  id: string;
  created_at: string;
  booking_ref: string | null;
  amount_cents: number;
  amount_refunded_cents: number | null;
  type: string;
  product: string | null;
  status: string;
}

async function sales(sb: ReturnType<typeof serviceClient>, slug: string, ymd: string) {
  const { start, end } = nyDayRange(ymd);
  const { data, error } = await sb
    .from("cash_sales")
    .select("id, created_at, booking_ref, amount_cents, amount_refunded_cents, type, product, status")
    .eq("kiosk_slug", slug)
    .eq("status", "success")
    .is("voided_at", null)
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString())
    .order("created_at", { ascending: false })
    .limit(2000)
    .returns<SaleRow[]>();
  if (error) return { error: error.message };
  const rows = data ?? [];

  // The booking each sale belongs to, the way Xano's addon attaches it. Matched by
  // reference: a ledger row's booking_id is often null (the tablet writes the
  // reference before the booking exists here).
  const refs = [...new Set(rows.map((r) => (r.booking_ref ?? "").trim()).filter(Boolean))];
  const byRef = new Map<string, ReturnType<typeof toXanoBooking>>();
  if (refs.length) {
    const { data: bs } = await sb
      .from("bookings")
      .select(BOOKING_SELECT)
      .or(`legacy_id.in.(${refs.join(",")}),xano_internal_id.in.(${refs.join(",")})`)
      .limit(2000)
      .returns<BookingRow[]>();
    for (const b of bs ?? []) {
      const x = toXanoBooking(b);
      for (const k of [b.legacy_id, b.xano_internal_id]) if (k && !byRef.has(k)) byRef.set(k, x);
    }
  }

  return {
    sales: rows.map((r) => {
      const net = r.amount_cents - (r.amount_refunded_cents ?? 0);
      const ref = (r.booking_ref ?? "").trim();
      return {
        id: r.id,
        created_at: new Date(r.created_at).getTime(),
        booking_id: ref || null,
        amount: (net / 100).toFixed(2),
        type: r.type,
        product: r.product ?? "ticket",
        kiosk: slug,
        status: r.status,
        booking_single: ref ? (byRef.get(ref) ?? null) : null,
      };
    }),
  };
}

// ── handler ───────────────────────────────────────────────────────────────────

Deno.serve(withSentry("kiosk-read", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  const action = body.action;
  if (action !== "products" && action !== "bookings" && action !== "sales") {
    return json({ error: "bad_action" }, 400);
  }

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk } = resolved;

  if (action === "products") {
    if (!kiosk.business_id) return json({ error: "kiosk_has_no_business" }, 409);
    const out = await products(sb, kiosk.business_id);
    return json(out, "error" in out ? 500 : 200);
  }

  const ymd = dayOf(body.date);
  if (!ymd) return json({ error: "bad_date" }, 400);
  const out = action === "bookings" ? await bookings(sb, ymd) : await sales(sb, kiosk.slug, ymd);
  return json(out, "error" in out ? 500 : 200);
}));
