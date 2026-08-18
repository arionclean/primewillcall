/**
 * Every cache key in one place.
 *
 * Keys are what let one screen's write show up on another screen without a
 * reload, so they are worth keeping honest: same data, same key, everywhere.
 * Each key carries the arguments that change the result, so a different day or
 * a different kiosk is a different entry rather than a stale overwrite.
 */
export const queryKeys = {
  /** Bookings for one service day, as the list and the manifest both see it. */
  bookings: (startUtc: string, endUtcExclusive: string) =>
    ["bookings", startUtc, endUtcExclusive] as const,

  /** Check-in manifest for a local date (the sidebar strip on kiosk logins). */
  manifest: (dateIso: string) => ["manifest", dateIso] as const,
} as const;
