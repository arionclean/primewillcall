"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { Menu, X } from "lucide-react";

import type { Database } from "@/lib/supabase/database.types";

import { AppSidebar, type SidebarBadges } from "./app-sidebar";
import { GlobalSearch } from "./global-search";
import { SidebarManifest } from "./sidebar-manifest";

type StaffRole = Database["public"]["Enums"]["staff_role"];

/**
 * Mobile-only navigation. A hamburger in the topbar opens a left drawer that
 * holds the global search and the same nav links as the desktop sidebar. The
 * drawer closes on navigation (including search-result jumps) so it never
 * lingers over the page the user just opened.
 */
export function MobileNav({
  role,
  canCreateBookings,
  badges,
}: {
  role: StaffRole;
  canCreateBookings: boolean;
  badges?: SidebarBadges;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="inline-flex size-9 items-center justify-center rounded-md border bg-background text-foreground transition hover:bg-muted md:hidden"
      >
        <Menu className="size-5" />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-50 md:hidden">
              <div
                className="absolute inset-0 bg-black/50 animate-in fade-in duration-200"
                onClick={() => setOpen(false)}
              />
              <div className="absolute inset-y-0 left-0 flex w-72 max-w-[82vw] flex-col gap-4 overflow-y-auto border-r bg-card p-4 shadow-xl animate-in slide-in-from-left duration-200">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold tracking-tight">
                    Prime
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close menu"
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <GlobalSearch />
                <AppSidebar
                  role={role}
                  canCreateBookings={canCreateBookings}
                  badges={badges}
                  onNavigate={() => setOpen(false)}
                />
                {role === "check_in" && <SidebarManifest />}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
