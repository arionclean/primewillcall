import { redirect } from "next/navigation";

import { PageTabs, type PageTab } from "@/components/app/page-tabs";
import { getCurrentStaff, staffCapabilities } from "@/lib/auth";

/**
 * The Payments screen: one title, two tabs. "Sales" is the transaction ledger
 * (card charges and cash sales, refundable); "Cash close" is the end-of-night
 * count, where the owner checks the money the desk handed over against the money
 * the system recorded and corrects a mistyped commission.
 *
 * The tabs are routes, so each keeps its own filters in its own URL and a reload
 * lands on the same tab. The gate is here as well as on each page: a check_in
 * login and anyone without can_view_payments never reaches either one.
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

  const tabs: PageTab[] = [
    { href: "/admin/payments", label: "Sales" },
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
