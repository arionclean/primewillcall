/**
 * New York wall-clock helpers, shared by the /gp edge functions.
 *
 * Business time is America/New_York. Bookings are stored in UTC, so a date plus a
 * slot time has to be converted through the zone's real offset (DST-correct), not
 * a fixed -5/-4. Mirrors the helpers in src/lib/dates.ts and the schedule action.
 */

export const BUSINESS_TZ = "America/New_York";

/** Today's date (YYYY-MM-DD) and the current minute-of-day in New York. */
export function nyNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return { date, minutes: hour * 60 + Number(get("minute")) };
}

/** Wall-clock New York date + time -> UTC ISO string (DST-correct). */
export function nyLocalToUtcIso(yyyyMmDd: string, hhmm: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const candidate = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const tzLabel =
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(candidate)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const off = tzLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = off?.[1] === "-" ? -1 : 1;
  const offMin = sign * (Number(off?.[2] ?? 0) * 60 + Number(off?.[3] ?? 0));
  return new Date(candidate.getTime() - offMin * 60_000).toISOString();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "Sep 22 2026 11:30 AM" / "Sep 22 2026" (the tablet's own format; also tolerates a
// comma and a full month name).
const NY_DISPLAY =
  /^([a-z]{3})[a-z]*\.?,?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(am|pm))?$/i;

/**
 * The PrimeKiosk tablet's `date_time`: the wall-clock line it prints on the ticket,
 * and since it writes here directly it is the ONLY start time it sends. Xano used to
 * turn that string into date_timestamp; nothing does now, so read it here.
 *
 * It is a New York wall time, so it is converted through the zone's real offset. That
 * is the whole point: reading it as UTC would store the hour four or five off, which
 * is why a display string in `starts_at` stays rejected.
 */
export function nyDisplayToUtcIso(s: string): string | null {
  const m = NY_DISPLAY.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 0 || day < 1 || day > 31) return null;
  const ymd = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // No time on the ticket: same placeholder a bare `date` gets.
  if (!m[4]) return `${ymd}T12:00:00.000Z`;
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (m[6].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (m[6].toLowerCase() === "am" && hour === 12) hour = 0;
  const iso = nyLocalToUtcIso(ymd, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** The New York calendar date of a UTC instant, as YYYY-MM-DD. */
export function nyDateString(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** "10:30:00" -> "10:30 AM". */
export function timeLabel(startTime: string): string {
  const [hStr, mStr] = startTime.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return startTime;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
