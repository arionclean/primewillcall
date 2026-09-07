/**
 * What the bookings list reads, shaped by the account's view permissions.
 *
 * Plain module on purpose: the server page (`page.tsx`) and the client list
 * (`list.tsx`) both call these, and a function exported from a "use client"
 * file cannot be called from the server (Next refuses it at render time, which
 * took /bookings down once). Types come from the list; that import is erased
 * at compile time, so there is no runtime cycle.
 */

import type { BookingCaps, BookingRow } from "./list";

/** The three permissions that shape what the list fetches and shows. */
export type BookingViewCaps = Pick<
  BookingCaps,
  "canViewDetails" | "canViewAttachments" | "canRedeemGroupon"
>;

/**
 * The columns the list reads, shaped by what this account may see. A column
 * an account may not see is left out of the query rather than hidden after
 * the fact, so it never reaches the device on the normal path: `notes`, the
 * customer's email and the reason a booking was voided are details, the
 * voucher photos are attachments, and the Redemption Codes go only to whoever
 * redeems. The void stamp itself (when, by whom) goes to every role, since the
 * row reads "Voided" for everyone; the voider's name comes through the staff
 * join and resolves only where staff RLS lets this account read it. RLS is row-level and
 * cannot do this, which is why the same rule lives here and in the Realtime
 * patch below (`withheldKeys`). Both the server page and the browser refetch
 * use it, so the two reads never disagree.
 */
export function bookingSelect(caps: BookingViewCaps): string {
  return `
  id,
  starts_at,
  ends_at,
  status,
  total_cents,
  due_cents,
  currency,
  business_id,
  business_tour_id,
  customer_id,
  checked_in_at,
  peek,
  source_channel,
  groupon_redeemed_at,
  voided_at,
  voided_by_staff_id,
  ${caps.canViewDetails ? "void_reason," : ""}
  voided_by:staff!bookings_voided_by_staff_id_fkey(full_name),
  ${caps.canViewAttachments ? "groupon_voucher_urls," : ""}
  ${caps.canRedeemGroupon ? "groupon_voucher_codes," : ""}
  pax_adult,
  pax_child,
  pax_infant,
  ${caps.canViewDetails ? "notes," : ""}
  business_tour:business_tours!bookings_business_tour_id_fkey(
    id,
    name,
    tour:tours(id, name, capacity)
  ),
  customer:customers!bookings_customer_id_fkey(id, full_name, phone${
    caps.canViewDetails ? ", email" : ""
  })
`;
}

/** Fill in what `bookingSelect` left out, so a row is always one shape. */
export function normalizeBookingRow(raw: unknown): BookingRow {
  const r = raw as BookingRow;
  return {
    ...r,
    notes: r.notes ?? null,
    void_reason: r.void_reason ?? null,
    voided_by: r.voided_by ?? null,
    groupon_voucher_urls: r.groupon_voucher_urls ?? [],
    groupon_voucher_codes: r.groupon_voucher_codes ?? [],
    customer: r.customer
      ? { ...r.customer, email: r.customer.email ?? null }
      : null,
  };
}

/** The row keys `bookingSelect` leaves out for this account. */
export function withheldKeys(caps: BookingViewCaps): (keyof BookingRow)[] {
  const keys: (keyof BookingRow)[] = [];
  if (!caps.canViewDetails) keys.push("notes", "void_reason");
  if (!caps.canViewAttachments) keys.push("groupon_voucher_urls");
  if (!caps.canRedeemGroupon) keys.push("groupon_voucher_codes");
  return keys;
}
