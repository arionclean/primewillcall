import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/app-shell";
import type { SidebarBadges } from "@/components/app/app-sidebar";
import { getCurrentStaff, staffCapabilities } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login");

  // No active staff row → render an unshelled "not linked" message and let the
  // child page handle the rest (today this only matters on /dashboard).
  if (!staff || !staff.is_active) {
    return <>{children}</>;
  }

  // Outstanding work for the sidebar. Only the owner sees /admin/unmatched, so
  // only they pay for the lookup, and it is a database-side COUNT (head: true)
  // rather than fetching the rows.
  const badges: SidebarBadges = {};
  if (staff.role === "owner") {
    const supabase = await getSupabaseServerClient();
    const { count } = await supabase
      .from("email_match_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "urgent");
    badges.unmatched = count ?? 0;
  }

  return (
    <AppShell
      role={staff.role}
      fullName={staff.full_name}
      canCreateBookings={staffCapabilities(staff).canCreateBookings}
      badges={badges}
    >
      {children}
    </AppShell>
  );
}
