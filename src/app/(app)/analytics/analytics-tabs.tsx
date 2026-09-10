"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type TabKey = "sales" | "departures" | "trends";

/**
 * In-page tabs for the Analytics charts. Every panel is server-rendered and
 * passed in; we keep them mounted and toggle visibility so each panel's local
 * state (filters, selections) survives switching tabs.
 *
 * Departures and Sales are the same panel counted on a different date. A
 * booking has both, often months apart: Departures answers "how full is the
 * boat on the day", Sales answers "what did we sell, and who sent it". They are
 * separate tabs rather than a filter because they are separate questions, and
 * an owner comparing months should never have to remember which one is on.
 * Sales opens first: the owner's question is what is selling and who is sending
 * it. The desk's question, how full the day is, lives on /bookings anyway.
 */
export function AnalyticsTabs({
  departures,
  sales,
  trends,
}: {
  departures: ReactNode;
  sales: ReactNode;
  trends: ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>("sales");

  const tabs: { key: TabKey; label: string }[] = [
    { key: "sales", label: "Sales" },
    { key: "departures", label: "Departures" },
    { key: "trends", label: "Monthly comparison" },
  ];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Analytics views"
        className="mb-6 flex gap-1 border-b"
      >
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition",
                active
                  ? "border-indigo-600 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div hidden={tab !== "sales"}>{sales}</div>
      <div hidden={tab !== "departures"}>{departures}</div>
      <div hidden={tab !== "trends"}>{trends}</div>
    </div>
  );
}
