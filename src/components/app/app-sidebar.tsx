"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
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
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { Database } from "@/lib/supabase/database.types";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: StaffRole[];
  matchPrefix?: string; // path prefix that highlights this item
  needsCreateBookings?: boolean; // hidden when the staffer can't create bookings
  badge?: BadgeKey; // shows an outstanding-work count from `badges`
};

/** Counts of work waiting for the user, surfaced as a pill on the nav item. */
export type BadgeKey = "unmatched";
export type SidebarBadges = Partial<Record<BadgeKey, number>>;

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
        // Selling desk staff's own money for the day (cash + card) plus the
        // end-of-night caja reconciliation. check_in only; owner/manager use the
        // fuller /admin/payments ledger. Add needsCreateBookings here to hide it
        // from reader-only tablets once those are in use.
        href: "/caja",
        label: "Caja",
        icon: Wallet,
        roles: ["check_in"],
        matchPrefix: "/caja",
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
        // check_in gets the "Add booking" button at the top instead.
        href: "/schedule",
        label: "Schedule",
        icon: CalendarPlus,
        roles: ["owner", "business_manager"],
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
        badge: "unmatched",
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
  badges,
  onNavigate,
}: {
  role: StaffRole;
  canCreateBookings: boolean;
  badges?: SidebarBadges;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // Prefetch on intent, not on sight. These routes are dynamic, so Next's
  // viewport prefetch only fetches the loading skeleton, and asking it to fetch
  // the real payload for all fourteen links would render fourteen pages on the
  // server every time the sidebar appears. Hovering is the honest signal that
  // one of them is about to be clicked, and it buys most of the round-trip back
  // (the pointer takes a beat to travel and press). Each href is prefetched at
  // most once per mount.
  const prefetched = useRef(new Set<string>());
  const prefetch = useCallback(
    (href: string) => {
      if (prefetched.current.has(href)) return;
      prefetched.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 text-sm">
      {role === "check_in" && canCreateBookings && (
        <Link
          href="/schedule"
          onClick={onNavigate}
          className={cn(buttonVariants({ variant: "default" }), "w-full")}
        >
          <CalendarPlus aria-hidden className="h-4 w-4" />
          Add booking
        </Link>
      )}
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
              const count = it.badge ? badges?.[it.badge] ?? 0 : 0;
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  prefetch={false}
                  onMouseEnter={() => prefetch(it.href)}
                  onFocus={() => prefetch(it.href)}
                  onTouchStart={() => prefetch(it.href)}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 transition",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className="h-[18px] w-[18px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {count > 0 ? (
                    <span
                      // Outstanding work, so it reads as "needs you", not decoration.
                      className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-red-600 tabular-nums dark:bg-red-950/50 dark:text-red-400"
                      aria-label={`${count.toLocaleString()} need review`}
                    >
                      {count > 999 ? "999+" : count.toLocaleString()}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
