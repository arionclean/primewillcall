/**
 * Plain-language labels for the kiosk event stream (kiosk_events.event), shared by
 * the Employees page. Anything not listed shows as its raw name, so a new event
 * from the tablet is never hidden, just unpolished.
 */

const LABELS: Record<string, string> = {
  pin_ok: "Signed in",
  pin_failed: "Wrong PIN",
  pin_locked: "PIN locked for a minute",
  pin_lock: "Locked the tablet",
  pin_auto_lock: "Locked after inactivity",
  app_launch: "Opened the app",
  app_foreground: "Returned to the app",
  app_background: "Left the app",
  config_fetched: "Tablet checked its settings",
  check_in: "Checked a guest in",
  check_in_undo: "Undid a check-in",
  sale_recorded: "Recorded a sale",
  booking_recorded: "Created a booking",
  sale_details_entered: "Entered guest details",
  sale_start: "Started a card sale",
  sale_started: "Card sale started on the server",
  sale_resumed: "Resumed a card sale",
  card_confirmed: "Card read",
  card_result: "Card result received",
  card_error: "Card error",
  card_recovered_after_error: "Payment recovered after a reader error",
  card_verify_failed: "Could not verify a card result",
  sale_paid_shown: "Card sale paid",
  sale_completed: "Card sale completed",
  sale_reused: "Attached to an earlier payment",
  sale_abandoned: "Card sale expired",
  sale_blocked_low_battery: "Card sale blocked, reader battery low",
  sale_start_failed: "Card sale could not start",
  sale_cancel_failed: "Could not cancel an expired card sale",
  xano_mirrored: "Sent to the old system",
  xano_mirror_failed: "Could not send to the old system",
  reader_connected: "Reader connected",
  reader_connection_status: "Reader connection changed",
  reader_disconnected: "Reader disconnected",
  reader_reconnecting: "Reader reconnecting",
  reader_reconnected: "Reader reconnected",
  reader_reconnect_failed: "Reader could not reconnect",
  reader_battery: "Reader battery reading",
  reader_low_battery: "Reader battery low",
};

export function eventLabel(event: string): string {
  return LABELS[event] ?? event.replace(/_/g, " ");
}

/** Events that mean a person did something, as opposed to the tablet or the server. */
export const PERSON_EVENTS = new Set([
  "pin_ok",
  "pin_failed",
  "pin_lock",
  "check_in",
  "check_in_undo",
  "sale_recorded",
  "booking_recorded",
  "sale_details_entered",
  "sale_start",
  "sale_paid_shown",
  "card_error",
]);

/** A short, human detail line from an event's payload. */
export function eventDetail(event: string, payload: Record<string, unknown> | null): string {
  const p = payload ?? {};
  const parts: string[] = [];
  const cents = typeof p.amount_cents === "number" ? p.amount_cents : typeof p.amount === "number" ? p.amount : null;
  if (cents !== null && cents > 0) parts.push(`$${(cents / 100).toFixed(2)}`);
  if (typeof p.type === "string") parts.push(p.type);
  if (typeof p.name === "string" && p.name) parts.push(p.name);
  if (typeof p.customer_name === "string" && p.customer_name) parts.push(p.customer_name);
  if (typeof p.message === "string" && p.message) parts.push(p.message);
  if (typeof p.reason === "string" && p.reason) parts.push(p.reason);
  if (typeof p.pct === "number") parts.push(`${p.pct}%`);
  if (event === "config_fetched" && typeof p.card_flow === "string") parts.push(`card flow ${p.card_flow}`);
  return parts.join(" · ");
}
