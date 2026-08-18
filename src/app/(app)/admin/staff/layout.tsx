import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * Owner-only gate for /admin/staff/*. Managers and check-in staff cannot
 * manage the team.
 */
export default async function StaffAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/staff");

  if (!staff || !staff.is_active || staff.role !== "owner") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
