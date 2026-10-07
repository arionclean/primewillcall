/**
 * Stripe payouts into `stripe_payouts`, shared by the two functions that write
 * them: stripe-webhook (payout.* events) and stripe-reports (the sync on every
 * Payouts tab open, plus the one-time backfill).
 *
 * Both callers read the payout from Stripe with `destination` expanded, so the
 * bank name and last 4 come along in the same call and no second request is ever
 * made for them.
 */

import type Stripe from "npm:stripe@22.3.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** The expand that makes `payout.destination` an object instead of an id. */
export const PAYOUT_EXPAND = ["destination"];

function bankOf(destination: Stripe.Payout["destination"]): {
  destination_id: string | null;
  bank_name: string | null;
  bank_last4: string | null;
} {
  if (!destination) return { destination_id: null, bank_name: null, bank_last4: null };
  if (typeof destination === "string") {
    return { destination_id: destination, bank_name: null, bank_last4: null };
  }
  if ("deleted" in destination && destination.deleted) {
    return { destination_id: destination.id, bank_name: null, bank_last4: null };
  }
  if (destination.object === "card") {
    const card = destination as Stripe.Card;
    return { destination_id: card.id, bank_name: card.brand ?? null, bank_last4: card.last4 ?? null };
  }
  const bank = destination as Stripe.BankAccount;
  return { destination_id: bank.id, bank_name: bank.bank_name ?? null, bank_last4: bank.last4 ?? null };
}

/** One `stripe_payouts` row from a Stripe payout. */
export function payoutRow(payout: Stripe.Payout, accountId: string, businessId: string | null) {
  return {
    stripe_payout_id: payout.id,
    business_id: businessId,
    connected_account_id: accountId,
    amount: payout.amount,
    currency: payout.currency,
    status: payout.status,
    // Stripe sends the arrival day as midnight UTC of that day: keep the date as is.
    arrival_date: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
    automatic: payout.automatic,
    method: payout.method ?? null,
    ...bankOf(payout.destination),
    failure_code: payout.failure_code ?? null,
    failure_message: payout.failure_message ?? null,
    statement_descriptor: payout.statement_descriptor ?? null,
    livemode: payout.livemode,
    stripe_created: new Date(payout.created * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export type PayoutRow = ReturnType<typeof payoutRow>;

/** Upsert on Stripe's id, in chunks so a full history never becomes one huge request. */
export async function upsertPayouts(db: SupabaseClient, rows: PayoutRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db
      .from("stripe_payouts")
      .upsert(rows.slice(i, i + 200), { onConflict: "stripe_payout_id" });
    if (error) throw new Error(`stripe_payouts upsert failed: ${error.message}`);
  }
}
