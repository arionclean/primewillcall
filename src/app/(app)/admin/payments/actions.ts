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

/** Shared passcode gate for the actions that touch money or whose kiosk it counts for. */
function checkPin(pin: string): string | null {
  const expected = process.env.REFUND_PIN;
  if (!expected) {
    return "This is locked: REFUND_PIN is not set in the app environment.";
  }
  if (!pin || !pinMatches(pin, expected)) return "Wrong passcode.";
  return null;
}

export async function refundTransaction(
  transactionId: string,
  amountCents: number,
  pin: string,
): Promise<RefundResult> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not authorized." };

  const pinError = checkPin(pin);
  if (pinError) return { error: pinError };

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
    // Stripe's own wording carries charge ids and API terms, so it stays in
    // the log and the manager gets one line they can act on.
    console.error("[payments] card refund failed:", err);
    return {
      error: "The refund did not go through. Try again, or check Stripe.",
    };
  }
}

/**
 * Refund a cash sale, full or partial. There is nothing to call Stripe about:
 * the money leaves the drawer by hand, so this records what was handed back and
 * the ledger follows (the sale reads "Refunded", its kiosk's caja drawer total
 * drops by the same amount, and the Refunded card on /admin/payments covers
 * both tenders).
 *
 * Same shape as the card refund: passcode, owner-or-that-business's-manager,
 * and a remaining balance recomputed from the row so a stale page cannot refund
 * past the sale. A DB check constraint refuses the write if both are bypassed.
 */
export async function refundCashSale(
  saleId: string,
  amountCents: number,
  pin: string,
): Promise<RefundResult> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not authorized." };
  if (staff.role === "check_in") return { error: "Not authorized." };

  const pinError = checkPin(pin);
  if (pinError) return { error: pinError };

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { error: "Enter a refund amount." };
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return { error: "Not configured." };

  const { data: sale } = await admin
    .from("cash_sales")
    .select("id, business_id, amount_cents, amount_refunded_cents")
    .eq("id", saleId)
    .maybeSingle();
  if (!sale) return { error: "Sale not found." };

  const allowed =
    staff.role === "owner" ||
    (staff.role === "business_manager" &&
      staff.business_id != null &&
      staff.business_id === sale.business_id);
  if (!allowed) return { error: "Not authorized." };

  // Recomputed from the DB row, not the client's copy: if someone else already
  // refunded part of this sale, a stale page cannot push the total over.
  const already = sale.amount_refunded_cents ?? 0;
  const remaining = (sale.amount_cents ?? 0) - already;
  if (remaining <= 0) return { error: "This sale is already fully refunded." };

  const amount = Math.floor(amountCents);
  if (amount > remaining) {
    return {
      error: `The most you can refund is $${(remaining / 100).toFixed(2)}. Reload the page to see the latest refunds.`,
    };
  }

  const { error } = await admin
    .from("cash_sales")
    .update({
      amount_refunded_cents: already + amount,
      refunded_at: new Date().toISOString(),
      refunded_by: staff.id,
    })
    .eq("id", saleId);
  if (error) {
    console.error("[payments] cash refund failed:", error);
    return { error: "Could not record the refund. Try again." };
  }

  revalidatePath("/admin/payments");
  revalidatePath("/caja");
  return { ok: true };
}

/**
 * Move a sale to a different kiosk. A tablet sometimes rings up a sale that
 * belongs to another kiosk; this re-tags it so it counts toward the right
 * kiosk's totals (payments feed, Source filter, that kiosk's caja).
 *
 * Passcode-gated like a refund: no money moves, but it shifts revenue between
 * kiosks, which is what staff are measured and paid on. The write goes through
 * the service role because the ledger tables have no client-facing write
 * policies; this action re-checks the role first. The DB keeps the pre-move
 * value in *_original and pins the new one against webhook overwrites (see
 * migration 20260811140000_move_sale_kiosk).
 */
export type MoveSourceResult = { error?: string; ok?: true };

export async function moveSaleSource(
  kind: "card" | "cash",
  saleId: string,
  nextSource: string,
  pin: string,
): Promise<MoveSourceResult> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not authorized." };
  if (staff.role === "check_in") return { error: "Not authorized." };

  const pinError = checkPin(pin);
  if (pinError) return { error: pinError };

  const target = nextSource.trim();
  if (!/^[a-z0-9_-]{1,32}$/i.test(target)) return { error: "Pick a kiosk." };

  const admin = getSupabaseAdminClient();
  if (!admin) return { error: "Not configured." };

  // The kiosk lives in a different column per table, so the two cases are
  // written out rather than built from variables: it keeps the generated
  // Supabase types checking the update.
  const canMove = (businessId: string | null) =>
    staff.role === "owner" ||
    (staff.role === "business_manager" &&
      staff.business_id != null &&
      staff.business_id === businessId);

  // First move records where the sale actually came from; later moves keep that
  // original, so the trail always points at what the tablet reported.
  const movedAt = new Date().toISOString();

  if (kind === "cash") {
    const { data: sale } = await admin
      .from("cash_sales")
      .select("id, business_id, kiosk_slug, kiosk_slug_original, source_moved_at")
      .eq("id", saleId)
      .maybeSingle();
    if (!sale) return { error: "Sale not found." };
    if (!canMove(sale.business_id)) return { error: "Not authorized." };
    if (sale.kiosk_slug === target) return { ok: true };

    const { error } = await admin
      .from("cash_sales")
      .update({
        kiosk_slug: target,
        kiosk_slug_original: sale.source_moved_at
          ? sale.kiosk_slug_original
          : sale.kiosk_slug,
        source_moved_at: movedAt,
        source_moved_by: staff.id,
      })
      .eq("id", saleId);
    if (error) {
      console.error("[payments] move sale failed:", error);
      return { error: "Could not move the sale. Try again." };
    }
  } else {
    const { data: sale } = await admin
      .from("stripe_transactions")
      .select("id, business_id, source, source_original, source_moved_at")
      .eq("id", saleId)
      .maybeSingle();
    if (!sale) return { error: "Sale not found." };
    if (!canMove(sale.business_id)) return { error: "Not authorized." };
    if (sale.source === target) return { ok: true };

    const { error } = await admin
      .from("stripe_transactions")
      .update({
        source: target,
        source_original: sale.source_moved_at
          ? sale.source_original
          : sale.source,
        source_moved_at: movedAt,
        source_moved_by: staff.id,
      })
      .eq("id", saleId);
    if (error) {
      console.error("[payments] move sale failed:", error);
      return { error: "Could not move the sale. Try again." };
    }
  }

  revalidatePath("/admin/payments");
  revalidatePath("/caja");
  return { ok: true };
}
