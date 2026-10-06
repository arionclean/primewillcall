import { notFound, redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { DisputeDetailView, type DisputeHeader } from "./dispute-detail";

/**
 * One dispute: where it stands, the payment and booking behind it, and the
 * answer (evidence to fight it, accepting it, or a refund while it is still an
 * inquiry). Owner only, like the rest of the Stripe screens.
 *
 * The header comes from our copy (stripe_disputes) so the page paints at once;
 * the view then loads the live dispute and its evidence from Stripe.
 */
export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { staff } = await getCurrentStaff();
  if (!staff || staff.role !== "owner") redirect("/admin/payments");

  const { id } = await params;
  if (!/^(du|dp)_[A-Za-z0-9]+$/.test(id)) notFound();

  const supabase = await getSupabaseServerClient();
  const { data: row } = await supabase
    .from("stripe_disputes")
    .select(
      "stripe_dispute_id, status, amount, currency, reason, customer_name, evidence_due_by, stripe_created, business:businesses(name)",
    )
    .eq("stripe_dispute_id", id)
    .maybeSingle();
  if (!row) notFound();

  const header: DisputeHeader = {
    id: row.stripe_dispute_id,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    reason: row.reason,
    customerName: row.customer_name,
    businessName: row.business?.name ?? null,
    dueBy: row.evidence_due_by,
    created: row.stripe_created,
  };

  return <DisputeDetailView header={header} />;
}
