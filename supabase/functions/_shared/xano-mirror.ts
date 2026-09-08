/**
 * Xano mirror: the pure part. What a booking looks like to Xano, and which Xano
 * fields an edit here becomes. No I/O, so it is unit-tested (xano-mirror.test.ts).
 * The worker (functions/xano-mirror-dispatch) does the reading and sending.
 *
 * The rules that matter (docs/xano-mirror.md):
 *  - No phone, ever. Xano's booking SMS trigger fires on insert when the row has a
 *    phone, and this platform already texted the guest. The literal "null" is what
 *    booking/v12 maps to a null phone. No email either, so Xano's contact trigger
 *    (phone or email) stays quiet too.
 *  - `trigger: false`, a second brake against any campaign keyed off that flag.
 *  - The Xano product is the business's own copy (business_tours.legacy_product_id)
 *    or, when the business has no Xano copy, the master tour's. Xano keys its day
 *    list on the product id regardless of company, so a Key West booking for a
 *    Miami product is exactly how Xano represents that today.
 *  - Time goes as the epoch millisecond plus the New York date, the two fields
 *    Xano's day list and its display read.
 */

import { nyDateString } from "./ny-time.ts";

/** Prefix of the internal ids this platform mints. Xano never produces it. */
export const MIRROR_REF_PREFIX = "SB-";

export function mirrorRef(): string {
  return `${MIRROR_REF_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

/** The booking, as the worker reads it. */
export interface MirrorBooking {
  id: string;
  status: "pending" | "confirmed" | "cancelled";
  starts_at: string;
  pax_adult: number;
  pax_child: number;
  pax_infant: number;
  notes: string | null;
  checked_in_at: string | null;
  legacy_id: string | null;
  legacy_reference: string | null;
  source_channel: string | null;
  public_token: string;
  due_cents: number;
  xano_internal_id: string | null;
  xano_booking_id: number | null;
  customer: { full_name: string | null } | null;
  business_tour: {
    name: string;
    legacy_product_id: string | null;
    tour: { legacy_product_id: string | null } | null;
    business: { name: string; legacy_company_id: string | null } | null;
  } | null;
}

export const XANO_STATUS: Record<MirrorBooking["status"], string> = {
  confirmed: "confirmed",
  pending: "pending",
  cancelled: "canceled",
};

/** "Ada Lovelace" -> { first: "Ada", last: "Lovelace" } */
export function splitName(full: string | null | undefined): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Xano product id for the booking's tour: the business's copy, else the master's. */
export function xanoProductId(b: MirrorBooking): string | null {
  return b.business_tour?.legacy_product_id ?? b.business_tour?.tour?.legacy_product_id ?? null;
}

/**
 * Why this booking cannot be represented in Xano, or null when it can. A terminal
 * failure: retrying does not help until the owner links the tour or business.
 */
export function unmirrorableReason(b: MirrorBooking): string | null {
  if (!b.business_tour?.business?.legacy_company_id) {
    return `The business "${b.business_tour?.business?.name ?? "?"}" is not linked to a Xano company.`;
  }
  if (!xanoProductId(b)) {
    return `The tour "${b.business_tour?.name ?? "?"}" is not linked to a Xano product.`;
  }
  return null;
}

function checkIn(b: MirrorBooking): { checked: boolean; check_in_time: number | null } {
  return {
    checked: b.checked_in_at != null,
    check_in_time: b.checked_in_at ? new Date(b.checked_in_at).getTime() : null,
  };
}

/** The full booking/v12 record for a booking born here. `ref` is its internal id. */
/**
 * The balance due, in the two fields the iPad reads: `payment_status` "pending" makes
 * the tablet show "Payment Pending" and offer cash or card, and `price` (cents) is the
 * amount it then collects. So `price` is what the guest still owes, never the booking
 * total. Paid in full: "completed", and no amount to collect.
 */
export function balanceFields(b: MirrorBooking): Record<string, unknown> {
  return b.due_cents > 0
    ? { payment_status: "pending", price: b.due_cents }
    : { payment_status: "completed", price: null };
}

export function buildCreatePayload(b: MirrorBooking, ref: string): Record<string, unknown> {
  const { first, last } = splitName(b.customer?.full_name);
  const startMs = new Date(b.starts_at).getTime();
  const reference = b.legacy_reference?.trim() || ref;
  return {
    internal_id: ref,
    booking_reference: reference,
    booking_channel: b.source_channel ?? "Manual",
    company: b.business_tour?.business?.legacy_company_id ?? "",
    product: xanoProductId(b) ?? "",
    product_var: b.business_tour?.name ?? "",
    supplier: b.business_tour?.business?.name ?? "",
    customer_name: `${last}, ${first}`.replace(/^, /, "").trim(),
    Fname: first,
    Lname: last,
    // The whole point: no phone, so Xano's SMS trigger has nowhere to send.
    phone: "null",
    email: "",
    date: nyDateString(b.starts_at),
    date_timestamp: startMs,
    adult: b.pax_adult,
    child: b.pax_child,
    infant: b.pax_infant,
    paxs: b.pax_adult + b.pax_child,
    status: XANO_STATUS[b.status],
    ...checkIn(b),
    ...balanceFields(b),
    live: true,
    trigger: false,
    kiosk: "",
    note: b.notes ?? "",
    unique_id: "",
    contact_status: "new",
    autoreschedule: false,
    // Our token becomes Xano's confirmation id: the guest link and the iPad's QR
    // lookup then find the same booking on either side.
    bookingConfirmation_id: b.public_token,
    image_url: [],
    pickupLocation_id: null,
    dropoffLocation_id: null,
  };
}

/**
 * The partial PATCH for the fields that changed. Only those, so a Xano-born booking
 * keeps everything Xano owns (its phone, its reference, its channel) untouched.
 */
export function buildUpdatePayload(b: MirrorBooking, fields: string[]): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const has = (f: string) => fields.includes(f);

  if (has("starts_at")) {
    // Sent as the two stored fields, not date_time: the PATCH's date_time helper
    // would rewrite `date` in a format Xano's own rows do not use.
    updates.date_timestamp = new Date(b.starts_at).getTime();
    updates.date = nyDateString(b.starts_at);
  }
  if (has("pax")) {
    updates.adult = b.pax_adult;
    updates.child = b.pax_child;
    updates.infant = b.pax_infant;
    updates.paxs = b.pax_adult + b.pax_child;
  }
  if (has("status")) {
    updates.status = XANO_STATUS[b.status];
  }
  if (has("checked_in_at")) {
    Object.assign(updates, checkIn(b));
  }
  if (has("notes")) {
    updates.note = b.notes ?? null;
  }
  if (has("due")) {
    Object.assign(updates, balanceFields(b));
  }
  if (has("business_tour_id")) {
    updates.product = xanoProductId(b) ?? "";
    updates.product_var = b.business_tour?.name ?? "";
    updates.supplier = b.business_tour?.business?.name ?? "";
    updates.company = b.business_tour?.business?.legacy_company_id ?? "";
  }
  return updates;
}

/** A Xano row id we can read straight off the booking, without asking Xano. */
export function knownXanoId(b: MirrorBooking): number | null {
  if (b.xano_booking_id) return b.xano_booking_id;
  const m = /^xano-(\d+)$/.exec(b.legacy_id ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The internal id Xano would know this booking by, when we have one: the one we
 * stored, else a legacy_id that IS an internal id (a kiosk KS code; the sync keys
 * those on unique_id, which the tablet sets equal to internal_id). An `ota-` or
 * `xano-` legacy_id is a reference or a row id, never an internal id.
 */
export function probableInternalId(b: MirrorBooking): string | null {
  if (b.xano_internal_id) return b.xano_internal_id;
  const l = b.legacy_id ?? "";
  if (!l || l.startsWith("ota-") || l.startsWith("xano-")) return null;
  return l;
}

/** Seconds to wait before retrying a transient failure: 1, 2, 4 ... minutes, capped at an hour. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));
}

/** After this many attempts (about a day of backoff) the row is marked failed. */
export const MAX_ATTEMPTS = 12;
