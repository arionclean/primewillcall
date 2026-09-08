import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/app-shell";
import { StaffClaimsSync } from "@/components/app/staff-claims-sync";
import { WebPinLock } from "@/components/app/web-pin-lock";
import { getCurrentStaff, staffCapabilities } from "@/lib/auth";
import { getWebEmployee } from "@/lib/employee-session";
import { QueryProvider } from "@/lib/query/provider";

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

  // A shared login (one computer, several people) shows the keypad until someone
  // has typed their PIN; that person then rides on every write for the log.
  const employee = staff.pin_required ? await getWebEmployee() : null;
  if (staff.pin_required && !employee) {
    return (
      <>
        <StaffClaimsSync staffId={staff.id} />
        <WebPinLock accountName={staff.full_name} />
      </>
    );
  }

  return (
    <QueryProvider>
      <StaffClaimsSync staffId={staff.id} />
      <AppShell
        role={staff.role}
        fullName={staff.full_name}
        canCreateBookings={staffCapabilities(staff).canCreateBookings}
        canUseCaja={staffCapabilities(staff).canUseCaja}
        canViewPayments={staffCapabilities(staff).canViewPayments}
        // The sidebar Manifest narrows its live feed to this business. Only a
        // manager is one business; a check-in login counts every business's
        // guests on its tours, so it gets the whole stream (RLS scopes it).
        businessId={staff.role === "business_manager" ? staff.business_id : null}
        employee={employee}
      >
        {children}
      </AppShell>
    </QueryProvider>
  );
}
