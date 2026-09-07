import { PageTabs, type PageTab } from "@/components/app/page-tabs";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The Team screen: one title, two tabs. "Team" is the staff logins (owner only);
 * "Employees" is the people who use the tablets and shared computers, with the
 * activity log. The tabs are routes, so the Employees filters live in its URL.
 */
export default async function StaffTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { staff } = await getCurrentStaff();
  const supabase = await getSupabaseServerClient();
  const { count } = await supabase
    .from("kiosk_employees")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);

  const tabs: PageTab[] = [
    ...(staff?.role === "owner" ? [{ href: "/admin/staff", label: "Team" }] : []),
    { href: "/admin/staff/employees", label: "Employees", count: count ?? 0 },
  ];

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Team</h1>
      <PageTabs tabs={tabs} label="Team views" />
      {children}
    </div>
  );
}
