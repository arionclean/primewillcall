"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getStripeClient } from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Refund a recorded Stripe charge. Supabase-native replacement for the Xano
 * refund endpoints (account/transaction/refund, stripe/transactions/refund).
 *
 * Layered auth: the /admin shell already requires an active staff row; this
 * action re-checks that the caller is the owner or the manager of the charge's
 * business, then does the Stripe call + ledger write with the service role
 * (the ledger tables have no client-facing write policies on purpose). The
 * webhook (charge.refunded) reconciles the transaction totals afterwards; we
 * also update them optimistically so the UI reflects the refund immediately.
 */

type RefundInsert = Database["public"]["Tables"]["stripe_refunds"]["Insert"];

export type RefundResult = { error?: string; ok?: true };

export async function refundTransaction(
  transactionId: string,
  amountCents?: number,
): Promise<RefundResult> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not authorized." };

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

  const remaining = (txn.amount ?? 0) - (txn.amount_refunded ?? 0);
  if (remaining <= 0) return { error: "This charge is already fully refunded." };

  const amount =
    amountCents && amountCents > 0
      ? Math.min(Math.floor(amountCents), remaining)
      : remaining;

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
