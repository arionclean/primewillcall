import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * /admin/staff/*: the Team section. Owners manage the team (the list, add, edit)
 * and the employees; a business manager gets the Employees tab only (the list
 * page sends them there). Check-in accounts have nothing here and go back to
 * Bookings. The owner-only pages sit under the (owner) route group with their
 * own gate.
 */
export default async function StaffAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/staff");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/bookings");

  return <>{children}</>;
}
