import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/app-shell";
import { getCurrentStaff, staffCapabilities } from "@/lib/auth";

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

  return (
    <AppShell
      role={staff.role}
      fullName={staff.full_name}
      canCreateBookings={staffCapabilities(staff).canCreateBookings}
    >
      {children}
    </AppShell>
  );
}
