import { PageTabs, type PageTab } from "@/components/app/page-tabs";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The Team screen: one title, three tabs. "Accounts" is every login, grouped by
 * business, owner only; "People" is the employees who type a PIN; "Activity" is
 * what everyone did, tablets and web. The tabs are routes, so the Activity
 * filters live in its URL.
 */
export default async function StaffTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { staff } = await getCurrentStaff();
  const supabase = await getSupabaseServerClient();
  const [people, accounts] = await Promise.all([
    supabase.from("kiosk_employees").select("id", { count: "exact", head: true }),
    supabase.from("staff").select("id", { count: "exact", head: true }),
  ]);

  const tabs: PageTab[] = [
    ...(staff?.role === "owner"
      ? [{ href: "/admin/staff/accounts", label: "Accounts", count: accounts.count ?? 0 }]
      : []),
    { href: "/admin/staff/people", label: "People", count: people.count ?? 0 },
    { href: "/admin/staff/activity", label: "Activity" },
  ];

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Team</h1>
      <PageTabs tabs={tabs} label="Team views" />
      {children}
    </div>
  );
}
