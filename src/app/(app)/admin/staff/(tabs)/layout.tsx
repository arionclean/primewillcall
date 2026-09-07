import { PageTabs, type PageTab } from "@/components/app/page-tabs";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The Team screen: one title, two tabs. "People" is everyone who works here
 * (PIN and/or website login) with the activity log; "Accounts" is the shared
 * desk and tablet logins, owner only. The tabs are routes, so the People
 * filters live in its URL.
 */
export default async function StaffTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { staff } = await getCurrentStaff();
  const supabase = await getSupabaseServerClient();
  const [logins, pinOnly, accounts] = await Promise.all([
    supabase.from("staff").select("id", { count: "exact", head: true }).in("role", ["owner", "business_manager"]),
    supabase.from("kiosk_employees").select("id", { count: "exact", head: true }).is("staff_id", null),
    supabase.from("staff").select("id", { count: "exact", head: true }).in("role", ["owner", "check_in"]),
  ]);

  const tabs: PageTab[] = [
    { href: "/admin/staff", label: "People", count: (logins.count ?? 0) + (pinOnly.count ?? 0) },
    ...(staff?.role === "owner"
      ? [{ href: "/admin/staff/accounts", label: "Accounts", count: accounts.count ?? 0 }]
      : []),
  ];

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Team</h1>
      <PageTabs tabs={tabs} label="Team views" />
      {children}
    </div>
  );
}
