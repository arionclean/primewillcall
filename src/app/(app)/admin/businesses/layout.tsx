import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * Owner-only gate for /admin/businesses/*. Managers and check-in staff get
 * bounced back to the dashboard.
 */
export default async function BusinessesAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/businesses");

  if (!staff || !staff.is_active || staff.role !== "owner") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
