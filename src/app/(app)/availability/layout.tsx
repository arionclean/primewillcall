import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/**
 * Owner and business-manager gate for /availability. Check-in staff can see
 * the schedule elsewhere but cannot open or close times, so they get bounced
 * to the dashboard.
 */
export default async function AvailabilityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/availability");
  if (!staff || !staff.is_active || staff.role === "check_in") {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
