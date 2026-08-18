import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * Owner-only gate for /admin/groupon/*. Managers and check-in staff get bounced
 * to the dashboard. The Groupon convenience fee is a platform-level setting, so
 * only Prime (owner) manages it.
 */
export default async function GrouponAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/groupon");

  if (!staff || !staff.is_active || staff.role !== "owner") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
