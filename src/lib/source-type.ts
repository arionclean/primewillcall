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
];

export function classifySource(source: string): SourceType {
  const s = source.toLowerCase();
  return OTA_KEYWORDS.some((k) => s.includes(k)) ? "OTA" : "ORGANIC";
}
