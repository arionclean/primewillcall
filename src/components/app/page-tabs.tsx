"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export type PageTab = {
  href: string;
  label: string;
  /** Shown as a small pill after the label, like a count. */
  count?: number;
};

/**
 * Page tabs that are routes, styled like the Messaging tabs. Each tab is a
 * link, so a tab can carry its own URL state (the Employees filters) and
 * reloads land on the same tab. The active one is the longest href the current
 * path starts with, so `/admin/staff` and `/admin/staff/employees` sort out.
 */
export function PageTabs({ tabs, label }: { tabs: PageTab[]; label: string }) {
  const pathname = usePathname();
  const activeHref = tabs
    .filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div role="tablist" aria-label={label} className="mb-6 flex gap-1 border-b">
      {tabs.map((t) => {
        const active = t.href === activeHref;
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition",
              active
                ? "border-indigo-600 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
