import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * Nested layout for everything under /admin/. Requires an active staff row.
 * Owner-only sections (businesses, staff) layer their own owner check on top
 * via their own nested layouts.
 *
 * The parent (app) layout already handles auth + AppShell, so this layout has
 * no chrome of its own.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin");

  if (!staff || !staff.is_active) {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
