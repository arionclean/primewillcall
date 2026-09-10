import { Suspense } from "react";

import type { Database } from "@/lib/supabase/database.types";

import { AppSidebar } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { GlobalSearch } from "./global-search";
import { SidebarManifest } from "./sidebar-manifest";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type AppShellProps = {
  role: StaffRole;
  fullName: string;
  canCreateBookings: boolean;
  canUseCaja: boolean;
  canViewPayments: boolean;
  businessId: string | null;
  /** The person unlocked on a shared login; null on a personal one. */
  employee: { name: string } | null;
  children: React.ReactNode;
};

export function AppShell({
  role,
  fullName,
  canCreateBookings,
  canUseCaja,
  canViewPayments,
  businessId,
  employee,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <AppTopbar
        role={role}
        fullName={fullName}
        canCreateBookings={canCreateBookings}
        canUseCaja={canUseCaja}
        canViewPayments={canViewPayments}
        businessId={businessId}
        employee={employee}
      />
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-8 md:grid-cols-[200px_1fr]">
        {/* Sticky, and capped to the viewport so a long list (the check-in
            Manifest on a busy day) scrolls inside the sidebar instead of being
            cut off below the fold. */}
        <aside className="hidden space-y-4 md:sticky md:top-6 md:block md:max-h-[calc(100vh-3rem)] md:self-start md:overflow-y-auto md:overscroll-contain md:pb-12">
          <GlobalSearch />
          <AppSidebar
            role={role}
            canCreateBookings={canCreateBookings}
            canUseCaja={canUseCaja}
            canViewPayments={canViewPayments}
          />
          {role === "check_in" && (
            // Suspense: SidebarManifest reads the URL via useSearchParams.
            <Suspense fallback={null}>
              <SidebarManifest businessId={businessId} />
            </Suspense>
          )}
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
