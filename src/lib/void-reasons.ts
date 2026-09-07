/**
 * The reasons staff can pick when voiding a booking or a cash sale.
 *
 * A void keeps the record and stamps why, so the reason is required. Staff pick
 * from a short list (consistent wording, so the activity log and any later
 * report can group them) or choose Other and type it. What is stored is plain
 * text either way: the chosen label, or what they typed. Shared by the bookings
 * edit modal and the Payments void dialog; edit the lists here.
 */

/** The dropdown value that reveals the free-text field. Never stored. */
export const OTHER_REASON = "__other__";

export const BOOKING_VOID_REASONS = [
  "Duplicate booking",
  "Entered by mistake",
  "Rebooked on another date or tour",
  "Test booking",
] as const;

export const CASH_SALE_VOID_REASONS = [
  "Entered twice",
  "Wrong amount",
  "Recorded by mistake",
  "Test sale",
] as const;

/**
 * The reason to store for a dropdown choice plus the Other text, or null when
 * nothing usable was given (no choice, or Other with an empty box).
 */
export function resolveVoidReason(choice: string, otherText: string): string | null {
  if (choice === OTHER_REASON) {
    const typed = otherText.trim();
    return typed ? typed.slice(0, 500) : null;
  }
  return choice.trim() || null;
}
