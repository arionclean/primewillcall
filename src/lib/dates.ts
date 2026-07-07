/**
 * Timezone-aware date helpers for the business operating timezone.
 *
 * The app runs on a single business timezone (America/New_York). These helpers
 * convert between a local YYYY-MM-DD date and the UTC [start, end) window that
 * covers that local day, which is what the bookings and check-in queries need.
 */

export const BUSINESS_TZ = "America/New_York";

/** Returns today's date as YYYY-MM-DD in the given timezone. */
export function todayLocalIso(timezone: string = BUSINESS_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "10:30" or "10:30:00" -> "10:30 AM". */
export function timeLabel(startTime: string): string {
  const [hStr, mStr] = startTime.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return startTime;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/** Validates a YYYY-MM-DD string, returning it normalized or null if invalid. */
export function parseLocalYmd(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseOffsetMinutes(label: string): number {
  const m = label.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * Returns the [startUtc, endUtcExclusive] window for a local YYYY-MM-DD date
 * in the given IANA timezone (a 24h day).
 */
export function getLocalDateRange(
  localYmd: string,
  timezone: string = BUSINESS_TZ,
): { startUtc: string; endUtcExclusive: string } {
  const [y, m, d] = localYmd.split("-").map(Number);
  const candidate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(candidate)
    .find((p) => p.type === "timeZoneName")?.value;
  const offsetMinutes = parseOffsetMinutes(tzLabel ?? "GMT+0");
  const startUtcMs = candidate.getTime() - offsetMinutes * 60_000;
  return {
    startUtc: new Date(startUtcMs).toISOString(),
    endUtcExclusive: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** First-of-month UTC instant for a local year + month (month is 1-12). */
export function monthStartUtc(
  year: number,
  month: number,
  timezone: string = BUSINESS_TZ,
): string {
  const mm = String(month).padStart(2, "0");
  return getLocalDateRange(`${year}-${mm}-01`, timezone).startUtc;
}

/** Converts a local date + HH:MM (in the given tz) to a UTC ISO string. */
export function localToUtcIso(
  yyyyMmDd: string,
  hhmm: string,
  timezone: string = BUSINESS_TZ,
): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const candidate = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(candidate)
    .find((p) => p.type === "timeZoneName")?.value;
  const offsetMinutes = parseOffsetMinutes(tzLabel ?? "GMT+0");
  return new Date(candidate.getTime() - offsetMinutes * 60_000).toISOString();
}
