/**
 * Classify a booking source as an OTA (third-party marketplace) or Organic
 * (direct, kiosk, own website). Used by the analytics filters and badges.
 */
export type SourceType = "OTA" | "ORGANIC";

const OTA_KEYWORDS = [
  "viator",
  "getyourguide",
  "get your guide",
  "groupon",
  "civitatis",
  "expedia",
  "tripadvisor",
  "klook",
  "headout",
  "tiqets",
  "musement",
  "airbnb",
  "booking.com",
  "tripshock",
  "i need tours",
  "eventbrite",
];

export function classifySource(source: string): SourceType {
  const s = source.toLowerCase();
  return OTA_KEYWORDS.some((k) => s.includes(k)) ? "OTA" : "ORGANIC";
}

/**
 * Whether a booking is a Groupon redemption, whichever door it came through.
 * The public /gp page writes `groupon`; Xano's Groupon page (and the Xano
 * round trip of a /gp booking) writes `groupon-surcharge`. Both are the same
 * thing to staff: a voucher to redeem on Groupon's platform.
 */
export function isGrouponChannel(source: string | null | undefined): boolean {
  const s = (source ?? "").trim().toLowerCase();
  return s === "groupon" || s === "groupon-surcharge";
}
