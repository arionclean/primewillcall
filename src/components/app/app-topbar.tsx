import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Database } from "@/lib/supabase/database.types";

import { MobileNav } from "./mobile-nav";

type StaffRole = Database["public"]["Enums"]["staff_role"];

const ROLE_LABEL: Record<StaffRole, string> = {
  owner: "Owner",
  business_manager: "Business manager",
  check_in: "Check-in staff",
};

const ROLE_TONE = {
  owner: "primary",
  business_manager: "info",
  check_in: "neutral",
} as const;

type AppTopbarProps = {
  role: StaffRole;
  fullName: string;
};

export function AppTopbar({ role, fullName }: AppTopbarProps) {
  return (
    <header className="border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <MobileNav role={role} />
          <Link
            href="/dashboard"
            className="text-sm font-semibold tracking-tight"
          >
            Prime
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden text-right text-xs leading-tight sm:block">
            <div className="font-medium">{fullName}</div>
            <div className="text-muted-foreground">{ROLE_LABEL[role]}</div>
          </div>
          <Badge tone={ROLE_TONE[role]} className="hidden sm:inline-flex">
            {ROLE_LABEL[role]}
          </Badge>
          <form action="/api/auth/signout" method="post">
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
