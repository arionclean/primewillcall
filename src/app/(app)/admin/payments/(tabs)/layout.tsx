import { redirect } from "next/navigation";

import { PageTabs, type PageTab } from "@/components/app/page-tabs";
import { getCurrentStaff, staffCapabilities } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The Payments screen: one title, tabs below it. "Sales" is the transaction
 * ledger (card charges and cash sales, refundable). Owner only: "Payouts" is
 * what Stripe holds and sends to each business's bank, with account health;
 * "Disputes" is every chargeback and inquiry, answered from here (its pill counts
 * the ones waiting for an answer, so a deadline is visible from any tab). "Cash
 * close", last, is the end-of-night count, where the owner checks the money the
 * desk handed over against the money the system recorded and corrects a
 * mistyped commission.
 *
 * The tabs are routes, so each keeps its own filters in its own URL and a reload
 * lands on the same tab. The gate is here as well as on each page: a check_in
 * login and anyone without can_view_payments never reaches any of them.
 */
export default async function PaymentsTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/payments");
  if (staff.role === "check_in") redirect("/dashboard");
  if (!staffCapabilities(staff).canViewPayments) redirect("/dashboard");

  const isOwner = staff.role === "owner";
  let waiting = 0;
  if (isOwner) {
    const supabase = await getSupabaseServerClient();
    const { count } = await supabase
      .from("stripe_disputes")
      .select("id", { count: "exact", head: true })
      .eq("bucket", "needs_response");
    waiting = count ?? 0;
  }

  const tabs: PageTab[] = [
    { href: "/admin/payments", label: "Sales" },
    ...(isOwner
      ? [
          { href: "/admin/payments/payouts", label: "Payouts" },
          { href: "/admin/payments/disputes", label: "Disputes", count: waiting },
        ]
      : []),
    { href: "/admin/payments/cash", label: "Cash close" },
  ];

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Payments</h1>
      <PageTabs tabs={tabs} label="Payments views" />
      {children}
    </div>
  );
}
