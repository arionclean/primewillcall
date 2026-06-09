"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MonthlyGuests } from "@/lib/dashboard/queries";

function monthHref(year: number, month: number): string {
  return `/dashboard?month=${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Guests-per-day for a month, with month navigation and a compare-to-last-month
 * delta. Pure data (people), no money. Each bar shows total guests, with the
 * checked-in portion filled darker. Hovering a bar shows a styled tooltip.
 */
export function MonthChart({ data }: { data: MonthlyGuests }) {
  const { year, month, monthLabel, days } = data;
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const max = Math.max(data.highestDay, 1);
  const monthShort = monthLabel.split(" ")[0];

  const [hovered, setHovered] = useState<number | null>(null);

  const delta = data.totalGuests - data.prevTotalGuests;
  const pct =
    data.prevTotalGuests > 0
      ? Math.round((delta / data.prevTotalGuests) * 100)
      : null;

  const active = hovered !== null ? days[hovered] : null;
  const xPct =
    hovered !== null ? ((hovered + 0.5) / days.length) * 100 : 0;
  // Keep the tooltip on-screen near the edges.
  const tx = xPct < 12 ? "0%" : xPct > 88 ? "-100%" : "-50%";

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            Guests per day
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {pct === null ? (
              "Checked-in guests are filled darker."
            ) : (
              <>
                <span
                  className={cn(
                    "font-medium",
                    delta >= 0 ? "text-emerald-600" : "text-red-600",
                  )}
                >
                  {delta >= 0 ? "+" : ""}
                  {pct}%
                </span>{" "}
                vs last month
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={monthHref(prev.y, prev.m)}
            aria-label="Previous month"
            className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <span className="min-w-[8.5rem] text-center text-sm font-medium">
            {monthLabel}
          </span>
          <Link
            href={monthHref(next.y, next.m)}
            aria-label="Next month"
            className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </Link>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_15rem]">
        {/* Chart */}
        {data.totalGuests === 0 ? (
          <div className="flex h-56 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No guests this month.
          </div>
        ) : (
          <div onMouseLeave={() => setHovered(null)}>
            <div className="relative">
              <div className="flex h-56 items-stretch gap-px">
                {days.map((d, i) => {
                  const totalH = (d.guests / max) * 100;
                  const checkedH =
                    d.guests > 0 ? (d.checkedGuests / d.guests) * 100 : 0;
                  const isActive = hovered === i;
                  return (
                    <div
                      key={d.day}
                      className="flex min-w-0 flex-1 flex-col justify-end"
                      onMouseEnter={() => setHovered(i)}
                    >
                      <div
                        className={cn(
                          "relative w-full rounded-t-sm transition-colors",
                          isActive ? "bg-indigo-300" : "bg-indigo-200",
                        )}
                        style={{
                          height: `${Math.max(totalH, d.guests > 0 ? 2 : 0)}%`,
                        }}
                      >
                        <div
                          className="absolute bottom-0 w-full rounded-t-sm bg-indigo-600"
                          style={{ height: `${checkedH}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Tooltip */}
              {active && (
                <div
                  className="pointer-events-none absolute z-20 w-max rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
                  style={{
                    left: `${xPct}%`,
                    top: `${Math.max((1 - active.guests / max) * 100, 8)}%`,
                    transform: `translate(${tx}, calc(-100% - 8px))`,
                  }}
                >
                  <div className="mb-1.5 font-semibold">
                    {monthShort} {active.day}
                  </div>
                  <div className="flex items-center justify-between gap-5">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2.5 rounded-sm bg-indigo-600" />
                      Checked in
                    </span>
                    <span className="font-semibold tabular-nums">
                      {active.checkedGuests}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-5">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2.5 rounded-sm bg-indigo-200" />
                      Total guests
                    </span>
                    <span className="font-semibold tabular-nums">
                      {active.guests}
                    </span>
                  </div>
                  {active.guests > 0 && (
                    <div className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">
                      {Math.round((active.checkedGuests / active.guests) * 100)}%
                      checked in
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Day labels (aligned under the bars) */}
            <div className="mt-1.5 flex gap-px">
              {days.map((d) => (
                <span
                  key={d.day}
                  className="min-w-0 flex-1 text-center text-[10px] text-muted-foreground"
                >
                  {d.day === 1 || d.day % 5 === 0 ? d.day : ""}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Quick stats */}
        <div className="space-y-1.5 text-sm">
          <Stat label="Total guests" value={data.totalGuests} />
          <Stat label="Checked in" value={data.checkedGuests} />
          <Stat
            label="Not checked in"
            value={data.totalGuests - data.checkedGuests}
          />
          <Stat label="Highest day" value={data.highestDay} />
          <Stat label="Daily average" value={data.dailyAverage} />
          <Stat label="Lowest day" value={data.lowestDay} />
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
