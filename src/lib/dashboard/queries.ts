import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * Dashboard data fetching helpers.
 *
 * All queries run against the authenticated server client and rely on RLS to
 * scope rows by the caller's staff role:
 *  - owner            → all businesses
 *  - business_manager → their business only
 *  - check_in         → bookings only on their assigned tours
 */

export type Supabase = SupabaseClient<Database>;

const DEFAULT_TIMEZONE = "America/New_York";

/** Returns the [startUtc, endUtcExclusive] window for "today" in the given timezone. */
export function getTodayRange(timezone: string = DEFAULT_TIMEZONE): {
  startUtc: string;
  endUtcExclusive: string;
  localDateLabel: string;
} {
  const now = new Date();
  // Use Intl to extract Y/M/D in the target timezone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));

  // Midnight in the target timezone. We approximate by constructing a Date
  // for midnight UTC of (y,m,d), then offsetting by the timezone difference
  // computed at that instant.
  const candidate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(candidate)
    .find((p) => p.type === "timeZoneName")?.value;
  // Parse offset string like "GMT-4" or "GMT-04:30".
  const offsetMinutes = parseOffset(tzLabel ?? "GMT+0");
  const startUtcMs = candidate.getTime() - offsetMinutes * 60_000;
  const start = new Date(startUtcMs);
  const end = new Date(startUtcMs + 24 * 60 * 60 * 1000);

  const localDateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(now);

  return {
    startUtc: start.toISOString(),
    endUtcExclusive: end.toISOString(),
    localDateLabel,
  };
}

function parseOffset(s: string): number {
  // "GMT", "GMT-4", "GMT+5:30", "GMT-04:30"
  const m = s.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const h = Number(m[2]);
  const min = m[3] ? Number(m[3]) : 0;
  return sign * (h * 60 + min);
}

// ── Row types returned to the UI ──────────────────────────────────────────────

export type DashboardKpis = {
  guests: number; // total pax today
  checkedGuests: number; // pax that have checked in
  notCheckedGuests: number; // pax still to arrive
};

export type TourTally = {
  name: string;
  color: string | null;
  count: number; // bookings today for this tour
  guests: number; // total pax today for this tour
};

export type MonthDay = {
  day: number; // day of month
  guests: number; // total pax that day
  checkedGuests: number; // pax that checked in that day
};

export type MonthlyGuests = {
  year: number;
  month: number; // 1-12
  monthLabel: string; // e.g. "June 2026"
  days: MonthDay[];
  totalGuests: number;
  checkedGuests: number;
  highestDay: number;
  lowestDay: number; // lowest among days that had guests
  dailyAverage: number; // over days that had guests
  prevTotalGuests: number; // previous month, for comparison
};

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getTodayKpis(
  supabase: Supabase,
  range = getTodayRange(),
): Promise<DashboardKpis> {
  // Pax-focused: the business counts people (guests), not bookings.
  const { data, error } = await supabase
    .from("bookings")
    .select("checked_in_at, pax_adult, pax_child, pax_infant")
    .gte("starts_at", range.startUtc)
    .lt("starts_at", range.endUtcExclusive)
    .neq("status", "cancelled");

  if (error) {
    console.error("[dashboard] getTodayKpis error:", error);
    return { guests: 0, checkedGuests: 0, notCheckedGuests: 0 };
  }

  let guests = 0;
  let checkedGuests = 0;
  for (const row of data ?? []) {
    const pax =
      (row.pax_adult ?? 0) + (row.pax_child ?? 0) + (row.pax_infant ?? 0);
    guests += pax;
    if (row.checked_in_at != null) checkedGuests += pax;
  }

  return { guests, checkedGuests, notCheckedGuests: guests - checkedGuests };
}

/** Today's bookings tallied by tour, for the per-tour cards. */
export async function getTodayByTour(
  supabase: Supabase,
  range = getTodayRange(),
): Promise<TourTally[]> {
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `pax_adult, pax_child, pax_infant,
       business_tour:business_tours!bookings_business_tour_id_fkey(
         name, tour:tours(name, color)
       )`,
    )
    .gte("starts_at", range.startUtc)
    .lt("starts_at", range.endUtcExclusive)
    .neq("status", "cancelled");

  if (error) {
    console.error("[dashboard] getTodayByTour error:", error);
    return [];
  }

  type Row = {
    pax_adult: number | null;
    pax_child: number | null;
    pax_infant: number | null;
    business_tour: {
      name: string;
      tour: { name: string; color: string | null } | null;
    } | null;
  };

  const map = new Map<string, TourTally>();
  for (const row of (data ?? []) as unknown as Row[]) {
    const bt = row.business_tour;
    const name = bt?.tour?.name ?? bt?.name ?? "Unknown tour";
    const color = bt?.tour?.color ?? null;
    const pax =
      (row.pax_adult ?? 0) + (row.pax_child ?? 0) + (row.pax_infant ?? 0);
    const cur = map.get(name) ?? { name, color, count: 0, guests: 0 };
    cur.count += 1;
    cur.guests += pax;
    map.set(name, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** Daily guest counts for a calendar month, plus stats and the prior month total. */
export async function getMonthlyGuests(
  supabase: Supabase,
  year: number,
  month: number, // 1-12
  timezone: string = DEFAULT_TIMEZONE,
): Promise<MonthlyGuests> {
  const monthStart = monthStartUtc(year, month, timezone);
  const nextStart = monthStartUtc(
    month === 12 ? year + 1 : year,
    month === 12 ? 1 : month + 1,
    timezone,
  );
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevStart = monthStartUtc(prevYear, prevMonth, timezone);

  const monthLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "long",
    year: "numeric",
  }).format(new Date(monthStart));

  // Aggregate per day inside the database (one ~31-row result), not in JS.
  const [cur, prev] = await Promise.all([
    rpcWithRetry(() =>
      supabase.rpc("dashboard_monthly_guests", {
        p_start: monthStart,
        p_end: nextStart,
        p_tz: timezone,
      }),
    ),
    rpcWithRetry(() =>
      supabase.rpc("dashboard_monthly_guests", {
        p_start: prevStart,
        p_end: monthStart,
        p_tz: timezone,
      }),
    ),
  ]);

  if (cur.error) console.error("[dashboard] monthly rpc error:", cur.error);
  if (prev.error) console.error("[dashboard] prev rpc error:", prev.error);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byDay = new Map<number, { guests: number; checkedGuests: number }>();
  for (let d = 1; d <= daysInMonth; d++) byDay.set(d, { guests: 0, checkedGuests: 0 });

  for (const r of cur.data ?? []) {
    byDay.set(Number(r.day), {
      guests: Number(r.guests),
      checkedGuests: Number(r.checked_guests),
    });
  }

  const days: MonthDay[] = Array.from(byDay.entries()).map(([day, v]) => ({
    day,
    guests: v.guests,
    checkedGuests: v.checkedGuests,
  }));

  const active = days.filter((d) => d.guests > 0);
  const totalGuests = days.reduce((s, d) => s + d.guests, 0);
  const checkedGuests = days.reduce((s, d) => s + d.checkedGuests, 0);
  const highestDay = active.reduce((m, d) => Math.max(m, d.guests), 0);
  const lowestDay = active.reduce((m, d) => Math.min(m, d.guests), highestDay);
  const dailyAverage = active.length
    ? Math.round(totalGuests / active.length)
    : 0;
  const prevTotalGuests = (prev.data ?? []).reduce(
    (s, r) => s + Number(r.guests),
    0,
  );

  return {
    year,
    month,
    monthLabel,
    days,
    totalGuests,
    checkedGuests,
    highestDay,
    lowestDay: active.length ? lowestDay : 0,
    dailyAverage,
    prevTotalGuests,
  };
}

export type SourceTourRow = {
  source: string;
  tour: string;
  color: string | null;
  businessId: string;
  business: string;
  pax: number;
  bookings: number;
};

/**
 * Supabase calls from the dev server (and, more rarely, serverless) sometimes
 * fail with a transient `fetch failed` when undici reuses a keep-alive socket
 * that Supabase has already closed. Retry a couple of times with a short
 * backoff before giving up; the retry almost always succeeds on a fresh socket.
 */
async function rpcWithRetry<T extends { error: unknown }>(
  run: () => PromiseLike<T>,
  attempts = 3,
): Promise<T> {
  let result = await run();
  for (let i = 1; i < attempts && result.error; i++) {
    await new Promise((r) => setTimeout(r, 150 * i));
    result = await run();
  }
  return result;
}

/** Pull a readable message out of a Supabase/Postgres error (avoids logging `{}`). */
function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: string; details?: string; code?: string };
    return e.message || e.details || e.code || JSON.stringify(error);
  }
  return String(error);
}

/** Bookings aggregated by sales source x tour for a window (database-side). */
export async function getAnalyticsSourceTour(
  supabase: Supabase,
  startUtc: string,
  endUtcExclusive: string,
): Promise<SourceTourRow[]> {
  const { data, error } = await rpcWithRetry(() =>
    supabase.rpc("analytics_source_tour", {
      p_start: startUtc,
      p_end: endUtcExclusive,
    }),
  );
  if (error) {
    console.error("[analytics] source_tour rpc error:", describeError(error));
    return [];
  }
  return (data ?? []).map((r) => ({
    source: r.source,
    tour: r.tour,
    color: r.color,
    businessId: r.business_id,
    business: r.business,
    pax: Number(r.pax),
    bookings: Number(r.bookings),
  }));
}

export type DailyTourRow = {
  day: number; // day of month (1-31), in business timezone
  businessTourId: string;
  tour: string;
  color: string | null;
  pax: number;
  bookings: number;
};

/**
 * Daily pax for a window, broken down by tour (database-side aggregation).
 * Used by the Monthly Comparison: the caller fetches a month and its previous
 * month, then filters/sums by selected tours on the client.
 */
export async function getAnalyticsDailyByTour(
  supabase: Supabase,
  startUtc: string,
  endUtcExclusive: string,
  timezone: string = DEFAULT_TIMEZONE,
): Promise<DailyTourRow[]> {
  const { data, error } = await rpcWithRetry(() =>
    supabase.rpc("analytics_daily_by_tour", {
      p_start: startUtc,
      p_end: endUtcExclusive,
      p_tz: timezone,
    }),
  );
  if (error) {
    console.error("[analytics] daily_by_tour rpc error:", describeError(error));
    return [];
  }
  return (data ?? []).map((r) => ({
    day: Number(r.day),
    businessTourId: r.business_tour_id,
    tour: r.tour,
    color: r.color,
    pax: Number(r.pax),
    bookings: Number(r.bookings),
  }));
}

/** UTC instant for the first day of a local month in the given timezone. */
function monthStartUtc(year: number, month: number, timezone: string): string {
  const candidate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(candidate)
    .find((p) => p.type === "timeZoneName")?.value;
  const offsetMinutes = parseOffset(tzLabel ?? "GMT+0");
  return new Date(candidate.getTime() - offsetMinutes * 60_000).toISOString();
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatCents(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/** Today's date (or `d`) as YYYY-MM-DD in business time (America/New_York). */
export function nyDateISO(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Shift a YYYY-MM-DD date string by whole calendar days (no timezone math). */
export function shiftDayISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Like formatCents but keeps the cents ($10.70), for per-charge ledger rows. */
export function formatCentsExact(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export function formatTimeRange(
  startsAt: string,
  endsAt: string,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${fmt.format(new Date(startsAt))} to ${fmt.format(new Date(endsAt))}`;
}

export function formatPax(b: {
  pax_adult: number;
  pax_child: number;
  pax_infant: number;
}): string {
  const parts: string[] = [];
  if (b.pax_adult) parts.push(`${b.pax_adult} adult${b.pax_adult === 1 ? "" : "s"}`);
  if (b.pax_child) parts.push(`${b.pax_child} child${b.pax_child === 1 ? "" : "ren"}`);
  if (b.pax_infant) parts.push(`${b.pax_infant} infant${b.pax_infant === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no pax";
}
