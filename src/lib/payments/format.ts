import { formatCentsExact, nyDateISO } from "@/lib/dashboard/queries";

/**
 * Formatting shared by the owner's Stripe screens (Payouts, Disputes). Moments
 * are shown in business time (America/New_York); a plain calendar date from
 * Stripe (a payout's arrival day) is not a moment and keeps the day it names.
 */

/** A plain calendar date ("Tue, Oct 6"), read in UTC so it never shifts a day. */
export function formatDay(isoDate: string, withWeekday = true): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: withWeekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(d);
}

const NY = "America/New_York";

/** A moment as a New York date ("Sep 4, 2026", the year only when not this year). */
export function formatNyDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = nyDateISO(d).slice(0, 4) === nyDateISO().slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(d);
}

/** A moment as New York date and time ("Oct 2, 9:04 AM"). */
export function formatNyDateTime(iso: string): string {
  const d = new Date(iso);
  const sameYear = nyDateISO(d).slice(0, 4) === nyDateISO().slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** A deadline, weekday included ("Tue, Oct 13 at 7:59 PM"). */
export function formatNyDeadline(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}

/** Whole New York days from today to a moment; negative once it has passed. */
export function daysUntilNy(iso: string): number {
  const today = new Date(`${nyDateISO()}T00:00:00Z`).getTime();
  const day = new Date(`${nyDateISO(new Date(iso))}T00:00:00Z`).getTime();
  return Math.round((day - today) / 86_400_000);
}

/** "7 days left", "Today", "1 day late". */
export function daysLeftLabel(days: number): string {
  if (days === 0) return "Today";
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} left`;
  return `${-days} day${days === -1 ? "" : "s"} late`;
}

/** Exact money with a real minus sign, as the Sales tab writes refunds. */
export function money(cents: number, currency?: string): string {
  return cents < 0 ? `−${formatCentsExact(-cents, currency)}` : formatCentsExact(cents, currency);
}

/** The bookings list on the booking's day, with that booking highlighted. */
export function bookingHref(id: string | null, startsAt: string | null): string | null {
  return id && startsAt ? `/bookings?date=${nyDateISO(new Date(startsAt))}&booking=${id}` : null;
}
