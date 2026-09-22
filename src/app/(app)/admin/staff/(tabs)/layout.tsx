import { PageTabs, type PageTab } from "@/components/app/page-tabs";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The Team screen: one title, five tabs. "Accounts" is every login, grouped by
 * business, owner only; "People" is the employees who type a PIN; "Hours" is
 * what they clocked on the tablets, owner only; "Sales" is the money each of
 * them took, owner only; "Activity" is what everyone did, tablets and web. The
 * tabs are routes, so the filters live in their URLs.
 */
export default async function StaffTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { staff } = await getCurrentStaff();
  const isOwner = staff?.role === "owner";
  const supabase = await getSupabaseServerClient();
  const [people, accounts, onTheClock] = await Promise.all([
    supabase.from("kiosk_employees").select("id", { count: "exact", head: true }),
    supabase.from("staff").select("id", { count: "exact", head: true }),
    // The pill on Hours is how many people are working right now, so the owner
    // sees it without opening the tab. Owner only, like the tab itself.
    isOwner
      ? supabase
          .from("time_clock_shifts")
          .select("id", { count: "exact", head: true })
          .is("clock_out_at", null)
      : Promise.resolve({ count: 0 }),
  ]);

  const tabs: PageTab[] = [
    ...(isOwner
      ? [{ href: "/admin/staff/accounts", label: "Accounts", count: accounts.count ?? 0 }]
      : []),
    { href: "/admin/staff/people", label: "People", count: people.count ?? 0 },
    ...(isOwner
      ? [{ href: "/admin/staff/hours", label: "Hours", count: onTheClock.count ?? 0 }]
      : []),
    ...(isOwner ? [{ href: "/admin/staff/sales", label: "Sales" }] : []),
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
