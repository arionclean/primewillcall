import { nyDateISO, shiftDayISO } from "@/lib/dashboard/queries";

/**
 * The ranges the Hours and Sales tabs offer, and the words they put on a
 * duration. Shared by the pages (which need the default range before rendering)
 * and the range bar (which changes it), so they can never disagree about what
 * "This week" means. Every date here is a New York day, like every other screen.
 */

/** Monday of the week `iso` falls in. Payroll weeks here start on Monday. */
export function weekStartISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return shiftDayISO(iso, dow === 0 ? -6 : 1 - dow);
}

/**
 * The presets on the filter bar, in the order they appear. Same shape as the
 * analytics bar: each one is a finished range, so the active one is simply the
 * one whose dates match the URL.
 */
export function rangePresets(today: string = nyDateISO()): { label: string; from: string; to: string }[] {
  const thisMonday = weekStartISO(today);
  const lastMonday = shiftDayISO(thisMonday, -7);
  const firstOfMonth = `${today.slice(0, 8)}01`;
  const lastOfPrevMonth = shiftDayISO(firstOfMonth, -1);
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: shiftDayISO(today, -1), to: shiftDayISO(today, -1) },
    { label: "This week", from: thisMonday, to: today },
    { label: "Last week", from: lastMonday, to: shiftDayISO(lastMonday, 6) },
    { label: "This month", from: firstOfMonth, to: today },
    { label: "Last month", from: `${lastOfPrevMonth.slice(0, 8)}01`, to: lastOfPrevMonth },
  ];
}

/** What Hours opens on: today, the question a desk asks most. */
export function defaultRange(today: string = nyDateISO()): { from: string; to: string } {
  return { from: today, to: today };
}

/** 492 -> "8h 12m". Minutes alone under an hour, so a short shift reads right. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** Hours as a decimal, which is what payroll spreadsheets want. */
export function decimalHours(minutes: number): string {
  return (Math.max(0, minutes) / 60).toFixed(2);
}
