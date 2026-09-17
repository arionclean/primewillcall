import { nyDateISO, shiftDayISO } from "@/lib/dashboard/queries";

/**
 * The ranges the Hours screen offers, and the words it puts on a duration.
 * Shared by the page (which needs the default range before rendering) and the
 * view (which changes it), so the two can never disagree about what "This week"
 * means. Every date here is a New York day, like every other screen.
 */

/** Monday of the week `iso` falls in. Payroll weeks here start on Monday. */
export function weekStartISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return shiftDayISO(iso, dow === 0 ? -6 : 1 - dow);
}

export const RANGE_PRESETS = [
  { key: "week", label: "This week" },
  { key: "lastWeek", label: "Last week" },
  { key: "today", label: "Today" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
] as const;

export type PresetKey = (typeof RANGE_PRESETS)[number]["key"] | "custom";

export function presetRange(key: PresetKey): { from: string; to: string } | null {
  const today = nyDateISO();
  switch (key) {
    case "week":
      return { from: weekStartISO(today), to: today };
    case "lastWeek": {
      const lastMonday = shiftDayISO(weekStartISO(today), -7);
      return { from: lastMonday, to: shiftDayISO(lastMonday, 6) };
    }
    case "today":
      return { from: today, to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": {
      const lastOfPrev = shiftDayISO(`${today.slice(0, 8)}01`, -1);
      return { from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev };
    }
    default:
      return null;
  }
}

export function detectPreset(from: string, to: string): PresetKey {
  for (const p of RANGE_PRESETS) {
    const range = presetRange(p.key);
    if (range && range.from === from && range.to === to) return p.key;
  }
  return "custom";
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
