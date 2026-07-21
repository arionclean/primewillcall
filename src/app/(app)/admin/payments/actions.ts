"use server";

import { timingSafeEqual } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getStripeClient } from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Refund a recorded Stripe charge (full or partial). Supabase-native
 * replacement for the Xano refund endpoints (account/transaction/refund,
 * stripe/transactions/refund).
 *
 * Layered auth: the /admin shell already requires an active staff row; this
 * action re-checks that the caller is the owner or the manager of the charge's
 * business AND that they typed the refund passcode (env REFUND_PIN), then does
 * the Stripe call + ledger write with the service role (the ledger tables have
 * no client-facing write policies on purpose). The webhook (charge.refunded)
 * reconciles the transaction totals afterwards; we also update them
 * optimistically so the UI reflects the refund immediately.
 */

type RefundInsert = Database["public"]["Tables"]["stripe_refunds"]["Insert"];

export type RefundResult = { error?: string; ok?: true };

function pinMatches(input: string, expected: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function refundTransaction(
  transactionId: string,
  amountCents: number,
  pin: string,
): Promise<RefundResult> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not authorized." };

  const expectedPin = process.env.REFUND_PIN;
  if (!expectedPin) {
    return { error: "Refunds are locked: REFUND_PIN is not set in the app environment." };
  }
  if (!pin || !pinMatches(pin, expectedPin)) return { error: "Wrong passcode." };

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { error: "Enter a refund amount." };
  }

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const { data: txn } = await admin
    .from("stripe_transactions")
    .select(
      "id, stripe_id, object_type, connected_account_id, business_id, amount, amount_refunded, currency, booking_id, status",
    )
    .eq("id", transactionId)
    .maybeSingle();
  if (!txn) return { error: "Transaction not found." };

  const allowed =
    staff.role === "owner" ||
    (staff.role === "business_manager" &&
      staff.business_id != null &&
      staff.business_id === txn.business_id);
  if (!allowed) return { error: "Not authorized." };

  if (txn.object_type !== "charge") {
    return { error: "Only card charges can be refunded here." };
  }

  // Recomputed from the DB row, not the client's copy: if someone else already
  // refunded part of this charge, a stale page cannot push the total over.
  const remaining = (txn.amount ?? 0) - (txn.amount_refunded ?? 0);
  if (remaining <= 0) return { error: "This charge is already fully refunded." };

  const amount = Math.floor(amountCents);
  if (amount > remaining) {
    return {
      error: `The most you can refund is $${(remaining / 100).toFixed(2)}. Reload the page to see the latest refunds.`,
    };
  }

  try {
    // Direct charges live on the connected account, so the refund must be
    // created there too.
    const refund = await stripe.refunds.create(
      { charge: txn.stripe_id, amount },
      txn.connected_account_id
        ? { stripeAccount: txn.connected_account_id }
        : undefined,
    );

    const row: RefundInsert = {
      stripe_refund_id: refund.id,
      transaction_id: txn.id,
      business_id: txn.business_id,
      booking_id: txn.booking_id,
      amount: refund.amount ?? amount,
      currency: txn.currency ?? "usd",
      status: refund.status ?? null,
      reason: refund.reason ?? null,
      created_by_staff_id: staff.id,
      raw: refund as unknown as RefundInsert["raw"],
    };
    await admin.from("stripe_refunds").insert(row);

    const newRefunded = (txn.amount_refunded ?? 0) + (refund.amount ?? amount);
    await admin
      .from("stripe_transactions")
      .update({
        amount_refunded: newRefunded,
        status: newRefunded >= (txn.amount ?? 0) ? "refunded" : txn.status,
      })
      .eq("id", txn.id);

    revalidatePath("/admin/payments");
    return { ok: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Refund failed.",
    };
  }
}
