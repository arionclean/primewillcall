"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type TabKey = "automations" | "templates";

/**
 * In-page tabs for the Messaging screen. Both panels are server-rendered and
 * passed in; we keep them mounted and toggle visibility so the automations
 * tab's local state (which message is open) survives switching tabs.
 */
export function MessagingTabs({
  automations,
  templates,
  templateCount,
}: {
  automations: ReactNode;
  templates: ReactNode;
  templateCount: number;
}) {
  const [tab, setTab] = useState<TabKey>("automations");

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "automations", label: "Automations" },
    { key: "templates", label: "WhatsApp templates", count: templateCount },
  ];

  return (
    <div>
      <div role="tablist" aria-label="Messaging views" className="mb-6 flex gap-1 border-b">
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
            </button>
          );
        })}
      </div>

      <div hidden={tab !== "automations"}>{automations}</div>
      <div hidden={tab !== "templates"}>{templates}</div>
    </div>
  );
}
