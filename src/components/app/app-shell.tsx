import { Suspense } from "react";

import type { Database } from "@/lib/supabase/database.types";

import { AppSidebar, type SidebarBadges } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { GlobalSearch } from "./global-search";
import { SidebarManifest } from "./sidebar-manifest";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type AppShellProps = {
  role: StaffRole;
  fullName: string;
  canCreateBookings: boolean;
  businessId: string | null;
  badges?: SidebarBadges;
  children: React.ReactNode;
};

export function AppShell({
  role,
  fullName,
  canCreateBookings,
  businessId,
  badges,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <AppTopbar
        role={role}
        fullName={fullName}
        canCreateBookings={canCreateBookings}
        businessId={businessId}
        badges={badges}
      />
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-8 md:grid-cols-[200px_1fr]">
        <aside className="hidden space-y-4 md:sticky md:top-6 md:block md:self-start">
          <GlobalSearch />
          <AppSidebar
            role={role}
            canCreateBookings={canCreateBookings}
            badges={badges}
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
