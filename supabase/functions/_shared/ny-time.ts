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
