/**
 * The kiosk event stream (kiosk_events.event) in plain language, shared by the
 * Employees page: a label per event, the action groups the page filters by, and a
 * short detail line from the payload. Anything not listed shows as its raw name,
 * so a new event from the tablet is never hidden, just unpolished; add it here
 * (label + group) when it lands.
 */

const LABELS: Record<string, string> = {
  // Sign-ins
  pin_ok: "Signed in",
  pin_failed: "Wrong PIN",
  pin_locked: "PIN locked for a minute",
  pin_lock: "Locked the tablet",
  pin_auto_lock: "Locked after inactivity",
  sign_out: "Signed the tablet out",
  // Guests and bookings
  check_in: "Checked a guest in",
  check_in_undo: "Undid a check-in",
  booking_recorded: "Created a booking",
  qr_scanned: "Scanned a ticket",
  receipt_printed: "Printed a receipt",
  sale_viewed: "Opened a sale",
  // Sales
  sale_recorded: "Recorded a sale",
  sale_details_entered: "Entered guest details",
  sale_start: "Started a card sale",
  sale_started: "Card sale started on the server",
  sale_resumed: "Resumed a card sale",
  card_confirmed: "Card read",
  card_result: "Card result received",
  card_retry: "Tried the card again",
  card_error: "Card error",
  card_recovered_after_error: "Payment recovered after a reader error",
  card_verify_failed: "Could not verify a card result",
  sale_paid_shown: "Card sale paid",
  sale_completed: "Card sale completed",
  sale_reused: "Attached to an earlier payment",
  sale_cancelled: "Cancelled a card sale",
  sale_abandoned: "Card sale expired",
  sale_blocked_low_battery: "Card sale blocked, reader battery low",
  sale_start_failed: "Card sale could not start",
  sale_cancel_failed: "Could not cancel an expired card sale",
  xano_mirrored: "Sent to the old system",
  xano_mirror_failed: "Could not send to the old system",
  // Reader
  reader_connected: "Reader connected",
  reader_connection_status: "Reader connection changed",
  reader_disconnected: "Reader disconnected",
  reader_disconnected_by_staff: "Disconnected the reader",
  reader_reconnecting: "Reader reconnecting",
  reader_reconnected: "Reader reconnected",
  reader_reconnect_failed: "Reader could not reconnect",
  reader_battery: "Reader battery reading",
  reader_low_battery: "Reader battery low",
  // Tablet housekeeping
  app_launch: "Opened the app",
  app_foreground: "Returned to the app",
  app_background: "Left the app",
  config_fetched: "Tablet checked its settings",
};

export function eventLabel(event: string): string {
  return LABELS[event] ?? event.replace(/_/g, " ");
}

/** Events that mean a person did something, as opposed to the tablet or the server. */
export const PERSON_EVENTS = new Set([
  "pin_ok",
  "pin_failed",
  "pin_lock",
  "sign_out",
  "check_in",
  "check_in_undo",
  "booking_recorded",
  "qr_scanned",
  "receipt_printed",
  "sale_viewed",
  "sale_recorded",
  "sale_details_entered",
  "sale_start",
  "sale_paid_shown",
  "sale_cancelled",
  "card_retry",
  "card_error",
  "reader_disconnected_by_staff",
]);

/**
 * The action groups the Activity filter offers. Each maps to the exact event names
 * the database is asked for (`kiosk_activity(p_events)`), so the filter is an index
 * lookup, not a pattern match. `eventGroup()` classifies a row the same way on the
 * client, for the live feed.
 */
export const EVENT_GROUPS = {
  sales: {
    label: "Sales",
    events: [
      "sale_recorded",
      "sale_details_entered",
      "sale_start",
      "sale_started",
      "sale_resumed",
      "card_confirmed",
      "card_result",
      "card_retry",
      "card_error",
      "card_recovered_after_error",
      "card_verify_failed",
      "sale_paid_shown",
      "sale_completed",
      "sale_reused",
      "sale_cancelled",
      "sale_abandoned",
      "sale_blocked_low_battery",
      "sale_start_failed",
      "sale_cancel_failed",
      "xano_mirrored",
      "xano_mirror_failed",
    ],
  },
  guests: {
    label: "Guests and bookings",
    events: ["check_in", "check_in_undo", "booking_recorded", "qr_scanned", "receipt_printed", "sale_viewed"],
  },
  signins: {
    label: "Sign-ins",
    events: ["pin_ok", "pin_failed", "pin_locked", "pin_lock", "pin_auto_lock", "sign_out"],
  },
  reader: {
    label: "Card reader",
    events: [
      "reader_connected",
      "reader_connection_status",
      "reader_disconnected",
      "reader_disconnected_by_staff",
      "reader_reconnecting",
      "reader_reconnected",
      "reader_reconnect_failed",
      "reader_battery",
      "reader_low_battery",
    ],
  },
  tablet: {
    label: "Tablet housekeeping",
    events: ["app_launch", "app_foreground", "app_background", "config_fetched"],
  },
} as const;

export type EventGroup = keyof typeof EVENT_GROUPS;

export function isEventGroup(s: string | null | undefined): s is EventGroup {
  return Boolean(s) && Object.prototype.hasOwnProperty.call(EVENT_GROUPS, s as string);
}

export function eventGroup(event: string): EventGroup | null {
  for (const key of Object.keys(EVENT_GROUPS) as EventGroup[]) {
    if ((EVENT_GROUPS[key].events as readonly string[]).includes(event)) return key;
  }
  if (event.startsWith("sale_") || event.startsWith("card_")) return "sales";
  if (event.startsWith("pin_")) return "signins";
  if (event.startsWith("reader_")) return "reader";
  if (event.startsWith("app_") || event.startsWith("config_")) return "tablet";
  return null;
}

/** A short, human detail line from an event's payload. */
export function eventDetail(event: string, payload: Record<string, unknown> | null): string {
  const p = payload ?? {};
  const parts: string[] = [];
  const cents = typeof p.amount_cents === "number" ? p.amount_cents : typeof p.amount === "number" ? p.amount : null;
  if (cents !== null && cents > 0) parts.push(`$${(cents / 100).toFixed(2)}`);
  if (typeof p.type === "string") parts.push(p.type);
  if (typeof p.product === "string" && p.product) parts.push(p.product);
  if (typeof p.name === "string" && p.name) parts.push(p.name);
  if (typeof p.customer_name === "string" && p.customer_name) parts.push(p.customer_name);
  if (typeof p.message === "string" && p.message) parts.push(p.message);
  if (typeof p.reason === "string" && p.reason) parts.push(p.reason);
  if (typeof p.code === "string" && p.code) parts.push(p.code);
  if (typeof p.pct === "number") parts.push(`${p.pct}%`);
  if (typeof p.pax === "number") parts.push(`${p.pax} pax`);
  if (event === "config_fetched" && typeof p.card_flow === "string") parts.push(`card flow ${p.card_flow}`);
  return parts.join(" · ");
}
