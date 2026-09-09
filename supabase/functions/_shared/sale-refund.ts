// Keep the sales ledger honest about card refunds.
//
// A card sale lands in two places: `stripe_transactions` (the money) and
// `cash_sales` (the sales ledger the kiosk day totals and the reconciliation
// read). Refunding only ever touched the first, so a refunded card sale kept
// showing its full value in the ledger. Seven sales, $1,041.11, were overstated
// that way between 2026-07-26 and 2026-09-06 before this existed. Cash refunds
// never had the problem: `refund_cash` writes the ledger row itself.
//
// Both refund paths call this, and both must:
//   - the payments function, so the screen is right the moment staff refund;
//   - the stripe-webhook, so a refund issued in Stripe's own dashboard lands too.
//
// It takes the TOTAL refunded on the charge rather than an increment, so running
// it twice (app then webhook) is harmless and a partial refund followed by
// another lands on the right number instead of double counting.
//
// The row is left visible and still `success`. A fully refunded sale nets to zero
// but staff can still see it happened, which beats the old stack's habit of
// dropping the row and leaving no trace.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Mirror a charge's refunded total onto its `cash_sales` row.
 *
 * Matched by `booking_ref` + card, which is how the two tables line up: a
 * ledger row's `booking_id` is often null (the tablet writes the reference
 * before the booking exists here), so the reference is the only key that always
 * holds. Voided rows are left alone; a void already zeroes the sale and its own
 * reason should not be overwritten by a refund arriving afterwards.
 *
 * Never throws. A refund must not fail because the ledger mirror did.
 */
export async function syncCardRefundToLedger(
  sb: SupabaseClient,
  bookingRef: string | null | undefined,
  totalRefundedCents: number,
): Promise<void> {
  const ref = (bookingRef ?? "").trim();
  if (!ref || !Number.isFinite(totalRefundedCents) || totalRefundedCents <= 0) return;

  try {
    const { data: sale } = await sb
      .from("cash_sales")
      .select("id, amount_cents, amount_refunded_cents, refunded_at, voided_at")
      .eq("booking_ref", ref)
      .eq("type", "card")
      .is("voided_at", null)
      .maybeSingle<{
        id: string;
        amount_cents: number;
        amount_refunded_cents: number | null;
        refunded_at: string | null;
        voided_at: string | null;
      }>();
    if (!sale) return;

    // Never claim more was returned than was taken: Stripe's total is per charge,
    // and a charge can in principle cover more than the one ledger row.
    const capped = Math.min(totalRefundedCents, sale.amount_cents ?? totalRefundedCents);
    if ((sale.amount_refunded_cents ?? 0) === capped) return;

    await sb
      .from("cash_sales")
      .update({
        amount_refunded_cents: capped,
        // Keep the first refund's timestamp: it is when the money started coming back.
        refunded_at: sale.refunded_at ?? new Date().toISOString(),
      })
      .eq("id", sale.id);
  } catch (err) {
    console.error("[sale-refund] could not mirror refund to cash_sales:", err);
  }
}
