import { nyDateISO, shiftDayISO } from "@/lib/dashboard/queries";

/**
 * The date-range presets the Payments screens share.
 *
 * Both tabs answer money questions over the same stretch of days, so they offer
 * the same choices and read the same URL. Keeping one definition here is what
 * stops "Last 30 days" meaning 30 on one tab and 29 on the other.
 *
 * Every date is a plain YYYY-MM-DD in business time (America/New_York): the day
 * the desk was open, not the caller's clock.
 */
export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
] as const;

export type PresetKey = (typeof RANGE_PRESETS)[number]["key"] | "custom";

export function presetRange(key: PresetKey): { from: string; to: string } | null {
  const today = nyDateISO();
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = shiftDayISO(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: shiftDayISO(today, -6), to: today };
    case "30d":
      return { from: shiftDayISO(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": {
      const firstOfThis = `${today.slice(0, 8)}01`;
      const lastOfPrev = shiftDayISO(firstOfThis, -1);
      return { from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev };
    }
    default:
      return null;
  }
}

/** Which preset a from/to pair is, or "custom" when it matches none of them. */
export function detectPreset(from: string, to: string): PresetKey {
  for (const p of RANGE_PRESETS) {
    const range = presetRange(p.key);
    if (range && range.from === from && range.to === to) return p.key;
  }
  return "custom";
}
