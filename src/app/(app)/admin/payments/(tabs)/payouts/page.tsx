import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { PayoutsView, type OpenDisputes, type PayoutRow } from "./payouts-view";

/**
 * Payouts: what Stripe holds for each business and what it has sent to the bank.
 * Owner only (the owner's call, 2026-10-06), checked here, in the tab list, in the
 * stripe-reports function and by the stripe_payouts select policy.
 *
 * The payout history is our own table (stripe_payouts), so it lists and pages
 * from the database. Everything Stripe answers live (balance, account health,
 * disputes, what is inside a payout) is fetched by the view after it paints, so
 * a slow Stripe never holds up the page.
 */

const PER_PAGE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; page?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || staff.role !== "owner") redirect("/admin/payments");

  const sp = await searchParams;
  const business = sp.business && UUID_RE.test(sp.business) ? sp.business : null;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const supabase = await getSupabaseServerClient();

  let list = supabase
    .from("stripe_payouts")
    .select(
      "stripe_payout_id, business_id, amount, currency, status, arrival_date, automatic, method, bank_name, bank_last4, failure_message, business:businesses(name)",
      { count: "exact" },
    )
    .order("arrival_date", { ascending: false })
    .order("stripe_created", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (business) list = list.eq("business_id", business);

  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name")
    .not("stripe_account_id", "is", null)
    .order("name");

  const [{ data: rows, count }, { data: disputeBuckets }, { data: nextDue }] = await Promise.all([
    list,
    // Disputes waiting for an answer, for the banner that points at their tab.
    supabase.rpc("stripe_disputes_summary"),
    supabase
      .from("stripe_disputes")
      .select("evidence_due_by")
      .eq("bucket", "needs_response")
      .not("evidence_due_by", "is", null)
      .order("evidence_due_by")
      .limit(1)
      .maybeSingle(),
  ]);

  const waiting = (disputeBuckets ?? []).find((b) => b.bucket === "needs_response");
  const openDisputes: OpenDisputes = {
    count: waiting?.disputes ?? 0,
    amount: waiting?.amount ?? 0,
    soonestDue: nextDue?.evidence_due_by ?? null,
  };

  const payouts: PayoutRow[] = (rows ?? []).map((r) => ({
    id: r.stripe_payout_id,
    businessId: r.business_id,
    businessName: r.business?.name ?? null,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    arrivalDate: r.arrival_date,
    automatic: r.automatic,
    instant: r.method === "instant",
    bankName: r.bank_name,
    bankLast4: r.bank_last4,
    failureMessage: r.failure_message,
  }));

  return (
    <PayoutsView
      openDisputes={openDisputes}
      payouts={payouts}
      businesses={businesses ?? []}
      business={business}
      page={page}
      perPage={PER_PAGE}
      total={count ?? 0}
    />
  );
}
