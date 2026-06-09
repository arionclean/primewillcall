import type { Database } from "@/lib/supabase/database.types";

import { AppSidebar } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { GlobalSearch } from "./global-search";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type AppShellProps = {
  role: StaffRole;
  fullName: string;
  children: React.ReactNode;
};

export function AppShell({ role, fullName, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <AppTopbar role={role} fullName={fullName} />
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-8 md:grid-cols-[200px_1fr]">
        <aside className="hidden space-y-4 md:sticky md:top-6 md:block md:self-start">
          <GlobalSearch />
          <AppSidebar role={role} />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
