import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * /admin/employees: the people who use the kiosk tablets and what they did.
 * Owners see every business; a business manager sees their own. Check-in
 * accounts have no business here to manage, so they go back to Bookings.
 */
export default async function EmployeesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/employees");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/bookings");
  return <>{children}</>;
}
