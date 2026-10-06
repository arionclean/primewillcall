import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import type { DisputeBucket } from "@/lib/payments/disputes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { DisputesView, type DisputeFilter, type DisputeListRow } from "./disputes-view";

/**
 * Disputes: every chargeback and inquiry on every business's Stripe account.
 * Owner only (the owner's call, 2026-10-06), checked here, in the tab list, in the
 * stripe-disputes function and by the stripe_disputes select policy.
 *
 * The list reads our copy (stripe_disputes), so it filters, pages and totals in
 * the database. The view re-syncs it from Stripe when it opens and redraws over
 * Realtime, and each dispute opens on its own page with the live evidence.
 */

const PER_PAGE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTERS: ReadonlySet<string> = new Set<DisputeFilter>([
  "all",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "closed",
]);

export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; business?: string; page?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || staff.role !== "owner") redirect("/admin/payments");

  const sp = await searchParams;
  const business = sp.business && UUID_RE.test(sp.business) ? sp.business : null;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const supabase = await getSupabaseServerClient();

  const [{ data: summaryRows }, { data: businesses }] = await Promise.all([
    supabase.rpc("stripe_disputes_summary", business ? { p_business: business } : {}),
    supabase.from("businesses").select("id, name").not("stripe_account_id", "is", null).order("name"),
  ]);

  const summary = Object.fromEntries(
    (summaryRows ?? []).map((r) => [r.bucket, { count: r.disputes, amount: r.amount }]),
  ) as Partial<Record<DisputeBucket, { count: number; amount: number }>>;

  // Open on what needs doing: the disputes waiting for an answer, when there are any.
  const filter: DisputeFilter =
    sp.status && FILTERS.has(sp.status)
      ? (sp.status as DisputeFilter)
      : (summary.needs_response?.count ?? 0) > 0
        ? "needs_response"
        : "all";

  let list = supabase
    .from("stripe_disputes")
    .select(
      "stripe_dispute_id, business_id, amount, currency, status, reason, network_reason_code, card_brand, evidence_due_by, evidence_past_due, submission_count, customer_name, stripe_created, business:businesses(name)",
      { count: "exact" },
    )
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (filter !== "all") list = list.eq("bucket", filter);
  if (business) list = list.eq("business_id", business);
  // Waiting for an answer: soonest deadline first. Everything else: newest first.
  list =
    filter === "needs_response"
      ? list.order("evidence_due_by", { ascending: true, nullsFirst: false })
      : list.order("stripe_created", { ascending: false });

  const { data: rows, count } = await list;

  const disputes: DisputeListRow[] = (rows ?? []).map((r) => ({
    id: r.stripe_dispute_id,
    businessName: r.business?.name ?? null,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    reason: r.reason,
    networkReasonCode: r.network_reason_code,
    cardBrand: r.card_brand,
    dueBy: r.evidence_due_by,
    pastDue: r.evidence_past_due,
    customerName: r.customer_name,
    created: r.stripe_created,
  }));

  return (
    <DisputesView
      disputes={disputes}
      summary={summary}
      filter={filter}
      business={business}
      businesses={businesses ?? []}
      page={page}
      perPage={PER_PAGE}
      total={count ?? 0}
    />
  );
}
