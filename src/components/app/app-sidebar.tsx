"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import type { Database } from "@/lib/supabase/database.types";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type NavItem = {
  href: string;
  label: string;
  roles: StaffRole[];
  matchPrefix?: string; // path prefix that highlights this item
};

type NavSection = {
  title: string | null;
  items: NavItem[];
};

const ALL_ROLES: StaffRole[] = ["owner", "business_manager", "check_in"];

const SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        roles: ALL_ROLES,
      },
      {
        href: "/bookings",
        label: "Bookings",
        roles: ALL_ROLES,
        matchPrefix: "/bookings",
      },
      {
        href: "/customers",
        label: "Customers",
        roles: ["owner", "business_manager"],
        matchPrefix: "/customers",
      },
      {
        href: "/schedule",
        label: "Schedule",
        roles: ALL_ROLES,
        matchPrefix: "/schedule",
      },
    ],
  },
  {
    title: "Manage",
    items: [
      {
        href: "/admin/businesses",
        label: "Businesses",
        roles: ["owner"],
        matchPrefix: "/admin/businesses",
      },
      {
        href: "/admin/tours",
        label: "Tours",
        roles: ["owner", "business_manager"],
        matchPrefix: "/admin/tours",
      },
      {
        href: "/analytics",
        label: "Analytics",
        roles: ["owner", "business_manager"],
        matchPrefix: "/analytics",
      },
      {
        href: "/admin/unmatched",
        label: "Unrecognized",
        roles: ["owner"],
        matchPrefix: "/admin/unmatched",
      },
      {
        href: "/admin/staff",
        label: "Team",
        roles: ["owner"],
        matchPrefix: "/admin/staff",
      },
    ],
  },
];

export function AppSidebar({
  role,
  onNavigate,
}: {
  role: StaffRole;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 text-sm">
      {SECTIONS.map((section, i) => {
        const visible = section.items.filter((it) => it.roles.includes(role));
        if (visible.length === 0) return null;
        return (
          <div key={i} className="flex flex-col gap-1">
            {section.title && (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </p>
            )}
            {visible.map((it) => {
              const active =
                pathname === it.href ||
                (it.matchPrefix && pathname.startsWith(it.matchPrefix));
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  className={cn(
                    "rounded-md px-3 py-2 transition",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {it.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
