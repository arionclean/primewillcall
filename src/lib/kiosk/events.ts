/**
 * The activity stream in plain language, shared by the Employees page.
 *
 * Two sources feed it. Tablet rows (kiosk_events) carry an event name the app
 * chose: pin_ok, check_in, sale_start. Web rows (audit_log, written by the
 * log_staff_change trigger) are named entity.action, e.g. bookings.updated, and
 * carry which columns changed plus a before/after diff; the label is read off
 * that, so "bookings.updated" with checked_in_at in the diff says "Checked a
 * guest in". Anything not listed shows as its raw name, never hidden, just
 * unpolished; add it here (label + group) when it lands.
 */

const LABELS: Record<string, string> = {
  // Sign-ins (tablet)
  pin_ok: "Signed in",
  pin_failed: "Wrong PIN",
  pin_locked: "PIN locked for a minute",
  pin_lock: "Locked the tablet",
  pin_auto_lock: "Locked after inactivity",
  sign_out: "Signed the tablet out",
  // Sign-ins (web)
  "employee.signed_in": "Signed in",
  "employee.signed_out": "Locked the screen",
  "employee.wrong_pin": "Wrong PIN",
  // Guests and bookings (tablet)
  check_in: "Checked a guest in",
  check_in_undo: "Undid a check-in",
  booking_recorded: "Created a booking",
  qr_scanned: "Scanned a ticket",
  receipt_printed: "Printed a receipt",
  sale_viewed: "Opened a sale",
  // Guests and bookings (web)
  "bookings.created": "Created a booking",
  "bookings.updated": "Edited a booking",
  "bookings.deleted": "Deleted a booking",
  "customers.created": "Added a guest",
  "customers.updated": "Edited a guest's details",
  "customers.deleted": "Removed a guest",
  // Sales (tablet)
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
  // Sales (web)
  "cash_sales.created": "Recorded a cash sale",
  "cash_sales.updated": "Edited a cash sale",
  "cash_sales.deleted": "Deleted a cash sale",
  "cash_sales.refunded": "Refunded a cash sale",
  "cash_sales.moved": "Moved a sale to another kiosk",
  "stripe_refunds.created": "Refunded a card payment",
  "stripe_transactions.moved": "Moved a card sale to another kiosk",
  // Reader (tablet)
  reader_connected: "Reader connected",
  reader_connection_status: "Reader connection changed",
  reader_disconnected: "Reader disconnected",
  reader_disconnected_by_staff: "Disconnected the reader",
  reader_reconnecting: "Reader reconnecting",
  reader_reconnected: "Reader reconnected",
  reader_reconnect_failed: "Reader could not reconnect",
  reader_battery: "Reader battery reading",
  reader_low_battery: "Reader battery low",
  // Settings and setup (web)
  "tour_slot_closures.created": "Closed a booking time",
  "tour_slot_closures.updated": "Changed a closed time",
  "tour_slot_closures.deleted": "Opened a booking time",
  "kiosk_employees.created": "Added an employee",
  "kiosk_employees.updated": "Edited an employee",
  "kiosk_employees.deleted": "Removed an employee",
  "staff.created": "Added a team member",
  "staff.updated": "Edited a team member",
  "staff.deleted": "Removed a team member",
  "staff_tours.created": "Assigned a tour to a team member",
  "staff_tours.deleted": "Unassigned a tour from a team member",
  "tours.created": "Added a tour",
  "tours.updated": "Edited a tour",
  "tours.deleted": "Removed a tour",
  "business_tours.created": "Added a tour to a business",
  "business_tours.updated": "Edited a business's tour",
  "business_tours.deleted": "Removed a tour from a business",
  "tour_pax_tiers.created": "Set prices",
  "tour_pax_tiers.updated": "Changed prices",
  "tour_pax_tiers.deleted": "Removed prices",
  "businesses.created": "Added a business",
  "businesses.updated": "Edited a business",
  "businesses.deleted": "Removed a business",
  "messaging_rules.created": "Added a message rule",
  "messaging_rules.updated": "Edited a message rule",
  "messaging_rules.deleted": "Removed a message rule",
  "messaging_settings.updated": "Changed messaging settings",
  "kiosks.updated": "Changed a tablet's settings",
  // Tablet housekeeping
  app_launch: "Opened the app",
  app_foreground: "Returned to the app",
  app_background: "Left the app",
  config_fetched: "Tablet checked its settings",
};

type Diff = Record<string, [unknown, unknown]>;

function diffOf(payload: Record<string, unknown> | null): Diff {
  const d = payload?.diff;
  return d && typeof d === "object" ? (d as Diff) : {};
}

/**
 * The label for a row. Web edits get a more exact one when the diff says what
 * happened: a check-in is "checked_in_at" going from empty to a time, a
 * cancellation is status turning "cancelled".
 */
export function eventLabel(event: string, changed: string[] = [], payload: Record<string, unknown> | null = null): string {
  const diff = diffOf(payload);
  const after = (col: string) => diff[col]?.[1];
  if (event === "bookings.updated") {
    if (changed.includes("checked_in_at")) return after("checked_in_at") ? "Checked a guest in" : "Undid a check-in";
    if (changed.includes("peek")) return after("peek") ? "Added to Peek" : "Removed from Peek";
    if (changed.includes("groupon_redeemed_at")) return after("groupon_redeemed_at") ? "Marked a Groupon redeemed" : "Unmarked a Groupon";
    if (changed.includes("status")) return after("status") === "cancelled" ? "Cancelled a booking" : `Changed a booking to ${String(after("status") ?? "")}`.trim();
    if (changed.includes("starts_at") || changed.includes("business_tour_id")) return "Moved a booking";
    if (changed.includes("customer_id")) return "Changed the guest on a booking";
    if (changed.includes("total_cents")) return "Changed a booking's price";
    if (changed.includes("notes")) return "Edited a booking's notes";
  }
  if (event === "kiosk_employees.updated") {
    if (changed.includes("pin_hash")) return "Changed an employee's PIN";
    if (changed.includes("is_active")) return after("is_active") ? "Reactivated an employee" : "Deactivated an employee";
  }
  if (event === "staff.updated") {
    if (changed.includes("pin_required")) return after("pin_required") ? "Turned on the PIN for a login" : "Turned off the PIN for a login";
    if (changed.includes("is_active")) return after("is_active") ? "Reactivated a team member" : "Deactivated a team member";
    if (changed.some((c) => c.startsWith("can_"))) return "Changed a team member's permissions";
  }
  return LABELS[event] ?? event.replace(/[._]/g, " ");
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

/** Every web row is a person's action; the tablet decides per event. */
export function isPersonEvent(event: string): boolean {
  return event.includes(".") || PERSON_EVENTS.has(event);
}

const SETUP_ENTITIES = [
  "tour_slot_closures",
  "kiosk_employees",
  "staff",
  "staff_tours",
  "tours",
  "business_tours",
  "tour_pax_tiers",
  "businesses",
  "messaging_rules",
  "messaging_settings",
  "kiosks",
];
const crud = (entities: string[], actions = ["created", "updated", "deleted"]) =>
  entities.flatMap((e) => actions.map((a) => `${e}.${a}`));

/**
 * The action groups the Activity filter offers. Each maps to the exact event names
 * the database is asked for (`activity_feed(p_events)`), so the filter is an index
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
      ...crud(["cash_sales"], ["created", "updated", "deleted", "refunded", "moved"]),
      "stripe_refunds.created",
      "stripe_transactions.moved",
    ],
  },
  guests: {
    label: "Guests and bookings",
    events: [
      "check_in",
      "check_in_undo",
      "booking_recorded",
      "qr_scanned",
      "receipt_printed",
      "sale_viewed",
      ...crud(["bookings", "customers"]),
    ],
  },
  signins: {
    label: "Sign-ins",
    events: [
      "pin_ok",
      "pin_failed",
      "pin_locked",
      "pin_lock",
      "pin_auto_lock",
      "sign_out",
      "employee.signed_in",
      "employee.signed_out",
      "employee.wrong_pin",
    ],
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
  setup: {
    label: "Settings and setup",
    events: crud(SETUP_ENTITIES),
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
  const entity = event.includes(".") ? event.split(".")[0] : null;
  if (entity) {
    if (SETUP_ENTITIES.includes(entity)) return "setup";
    if (entity === "bookings" || entity === "customers") return "guests";
    if (entity.startsWith("cash_") || entity.startsWith("stripe_")) return "sales";
    if (entity === "employee") return "signins";
    return null;
  }
  if (event.startsWith("sale_") || event.startsWith("card_")) return "sales";
  if (event.startsWith("pin_")) return "signins";
  if (event.startsWith("reader_")) return "reader";
  if (event.startsWith("app_") || event.startsWith("config_")) return "tablet";
  return null;
}

const money = (cents: unknown) => (typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : null);

/** A short, human detail line from an event's payload. */
export function eventDetail(event: string, payload: Record<string, unknown> | null): string {
  const p = payload ?? {};
  const parts: string[] = [];

  if (event.includes(".")) {
    // Web rows: the guest, then whatever the diff or the new row says in money or words.
    if (typeof p.guest === "string" && p.guest) parts.push(p.guest);
    const row = (p.row && typeof p.row === "object" ? p.row : {}) as Record<string, unknown>;
    const diff = diffOf(payload);
    const name = [row.full_name, row.name, row.customer_name].find((v) => typeof v === "string" && v);
    if (name) parts.push(String(name));
    const amount = money(row.amount_cents) ?? money(row.total_cents) ?? money(p.amount_cents);
    if (amount) parts.push(amount);
    if (diff.total_cents) parts.push(`${money(diff.total_cents[0]) ?? "?"} to ${money(diff.total_cents[1]) ?? "?"}`);
    if (diff.amount_cents) parts.push(`${money(diff.amount_cents[0]) ?? "?"} to ${money(diff.amount_cents[1]) ?? "?"}`);
    if (diff.status) parts.push(`${String(diff.status[0])} to ${String(diff.status[1])}`);
    if (typeof p.from === "string" && typeof p.to === "string") parts.push(`${p.from} to ${p.to}`);
    if (typeof row.pax === "number") parts.push(`${row.pax} pax`);
    return parts.join(" · ");
  }

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
