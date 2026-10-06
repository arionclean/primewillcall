/**
 * Stripe disputes into `stripe_disputes`, shared by the functions that write
 * them: stripe-webhook (charge.dispute.* events) and stripe-disputes (the sync on
 * every Disputes tab open, and after the owner saves, submits or accepts).
 *
 * The row links the dispute to our ledger (the stripe_transactions row for the
 * charge, its booking and the guest's name), so the list can name the guest and
 * open the booking without asking Stripe.
 */

import type Stripe from "npm:stripe@22.3.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** The two statuses where the bank is still waiting for an answer. */
export const ANSWERABLE_STATUSES: ReadonlySet<string> = new Set([
  "needs_response",
  "warning_needs_response",
]);

export function chargeIdOf(charge: string | Stripe.Charge | null | undefined): string | null {
  if (!charge) return null;
  return typeof charge === "string" ? charge : charge.id;
}

interface LedgerLink {
  transaction_id: string;
  booking_id: string | null;
  customer_name: string | null;
}

/** Our ledger rows for a set of charges, in one query per 200. */
async function ledgerLinks(db: SupabaseClient, chargeIds: string[]): Promise<Map<string, LedgerLink>> {
  const out = new Map<string, LedgerLink>();
  const ids = [...new Set(chargeIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db
      .from("stripe_transactions")
      .select("id, stripe_id, booking_id, customer_name")
      .in("stripe_id", ids.slice(i, i + 200));
    for (const t of data ?? []) {
      out.set(t.stripe_id, { transaction_id: t.id, booking_id: t.booking_id, customer_name: t.customer_name });
    }
  }
  return out;
}

export interface DisputeOnAccount {
  dispute: Stripe.Dispute;
  accountId: string;
  businessId: string | null;
}

function disputeRow({ dispute: d, accountId, businessId }: DisputeOnAccount, link: LedgerLink | undefined) {
  const card = d.payment_method_details?.card;
  return {
    stripe_dispute_id: d.id,
    business_id: businessId,
    connected_account_id: accountId,
    charge_id: chargeIdOf(d.charge),
    transaction_id: link?.transaction_id ?? null,
    booking_id: link?.booking_id ?? null,
    customer_name: link?.customer_name ?? null,
    amount: d.amount,
    currency: d.currency,
    status: d.status,
    reason: d.reason,
    network_reason_code: card?.network_reason_code ?? null,
    card_brand: card?.brand ?? null,
    is_charge_refundable: d.is_charge_refundable,
    evidence_due_by: d.evidence_details?.due_by
      ? new Date(d.evidence_details.due_by * 1000).toISOString()
      : null,
    has_evidence: Boolean(d.evidence_details?.has_evidence),
    evidence_past_due: Boolean(d.evidence_details?.past_due),
    submission_count: d.evidence_details?.submission_count ?? 0,
    livemode: d.livemode,
    stripe_created: new Date(d.created * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** Upsert disputes on Stripe's id, linked to our ledger. */
export async function upsertDisputes(db: SupabaseClient, items: DisputeOnAccount[]): Promise<void> {
  if (items.length === 0) return;
  const links = await ledgerLinks(db, items.map((i) => chargeIdOf(i.dispute.charge) ?? ""));
  const rows = items.map((i) => disputeRow(i, links.get(chargeIdOf(i.dispute.charge) ?? "")));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db
      .from("stripe_disputes")
      .upsert(rows.slice(i, i + 200), { onConflict: "stripe_dispute_id" });
    if (error) throw new Error(`stripe_disputes upsert failed: ${error.message}`);
  }
}
