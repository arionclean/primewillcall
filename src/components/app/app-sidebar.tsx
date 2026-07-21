"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CalendarCheck,
  Users,
  CalendarPlus,
  CalendarClock,
  Building2,
  Compass,
  BarChart3,
  CreditCard,
  Inbox,
  MessageSquare,
  Tag,
  UserCog,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { Database } from "@/lib/supabase/database.types";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: StaffRole[];
  matchPrefix?: string; // path prefix that highlights this item
  needsCreateBookings?: boolean; // hidden when the staffer can't create bookings
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
        icon: LayoutDashboard,
        roles: ["owner", "business_manager"],
      },
      {
        href: "/bookings",
        label: "Bookings",
        icon: CalendarCheck,
        roles: ALL_ROLES,
        matchPrefix: "/bookings",
      },
      {
        href: "/customers",
        label: "Customers",
        icon: Users,
        roles: ["owner", "business_manager"],
        matchPrefix: "/customers",
      },
      {
        href: "/messages",
        label: "Messages",
        icon: MessageSquare,
        roles: ["owner", "business_manager"],
        matchPrefix: "/messages",
      },
      {
        href: "/schedule",
        label: "Schedule",
        icon: CalendarPlus,
        roles: ALL_ROLES,
        matchPrefix: "/schedule",
        needsCreateBookings: true,
      },
      {
        href: "/availability",
        label: "Availability",
        icon: CalendarClock,
        roles: ["owner", "business_manager"],
        matchPrefix: "/availability",
      },
    ],
  },
  {
    title: "Manage",
    items: [
      {
        href: "/admin/businesses",
        label: "Businesses",
        icon: Building2,
        roles: ["owner"],
        matchPrefix: "/admin/businesses",
      },
      {
        href: "/admin/tours",
        label: "Tours",
        icon: Compass,
        roles: ["owner", "business_manager"],
        matchPrefix: "/admin/tours",
      },
      {
        href: "/analytics",
        label: "Analytics",
        icon: BarChart3,
        roles: ["owner", "business_manager"],
        matchPrefix: "/analytics",
      },
      {
        href: "/admin/payments",
        label: "Payments",
        icon: CreditCard,
        roles: ["owner", "business_manager"],
        matchPrefix: "/admin/payments",
      },
      {
        href: "/admin/unmatched",
        label: "Unrecognized",
        icon: Inbox,
        roles: ["owner"],
        matchPrefix: "/admin/unmatched",
      },
      {
        href: "/admin/groupon",
        label: "Groupon fees",
        icon: Tag,
        roles: ["owner"],
        matchPrefix: "/admin/groupon",
      },
      {
        href: "/admin/messaging",
        label: "Automations",
        icon: Zap,
        roles: ["owner"],
        matchPrefix: "/admin/messaging",
      },
      {
        href: "/admin/staff",
        label: "Team",
        icon: UserCog,
        roles: ["owner"],
        matchPrefix: "/admin/staff",
      },
    ],
  },
];

export function AppSidebar({
  role,
  canCreateBookings,
  onNavigate,
}: {
  role: StaffRole;
  canCreateBookings: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 text-sm">
      {SECTIONS.map((section, i) => {
        const visible = section.items.filter(
          (it) =>
            it.roles.includes(role) &&
            (!it.needsCreateBookings || canCreateBookings),
        );
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
              const Icon = it.icon;
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 transition",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className="h-[18px] w-[18px] shrink-0" />
                  <span>{it.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
