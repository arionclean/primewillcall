"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type TabKey = "sources" | "trends";

/**
 * In-page tabs for the Analytics charts. Both panels are server-rendered and
 * passed in; we keep them mounted and toggle visibility so each panel's local
 * state (filters, selections) survives switching tabs.
 */
export function AnalyticsTabs({
  sources,
  trends,
}: {
  sources: ReactNode;
  trends: ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>("sources");

  const tabs: { key: TabKey; label: string }[] = [
    { key: "sources", label: "Sources & products" },
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

      <div hidden={tab !== "sources"}>{sources}</div>
      <div hidden={tab !== "trends"}>{trends}</div>
    </div>
  );
}
