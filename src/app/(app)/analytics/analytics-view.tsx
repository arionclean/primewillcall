"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { cn } from "@/lib/utils";
import { classifySource } from "@/lib/source-type";
import type { SourceTourRow } from "@/lib/dashboard/queries";

type AnalyticsViewProps = {
  rows: SourceTourRow[];
  from: string;
  to: string;
  today: string;
};

type TypeFilter = "all" | "ORGANIC" | "OTA";
type GroupBy = "source" | "tour";

function addDaysIso(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function csvCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV in memory and trigger a client-side download (no server round-trip). */
function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number)[][],
) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AnalyticsView({ rows, from, to, today }: AnalyticsViewProps) {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("source");
  const [businessFilter, setBusinessFilter] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);

  const setRange = (f: string, t: string) =>
    router.push(`/analytics?from=${f}&to=${t}`);

  // Distinct businesses present in the data. Owners see 2+, managers see 1
  // (RLS already scopes the rows), so the filter only shows for owners.
  const businesses = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.businessId, r.business);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const showBusinessFilter = businesses.length > 1;

  // Rows scoped to the selected business.
  const baseRows = useMemo(
    () =>
      businessFilter === "all"
        ? rows
        : rows.filter((r) => r.businessId === businessFilter),
    [rows, businessFilter],
  );

  // Header totals (always the full picture for the business + range).
  const totals = useMemo(() => {
    let guests = 0;
    let bookings = 0;
    let ota = 0;
    for (const r of baseRows) {
      guests += r.pax;
      bookings += r.bookings;
      if (classifySource(r.source) === "OTA") ota += r.pax;
    }
    return { guests, bookings, ota, organic: guests - ota };
  }, [baseRows]);

  const groupingBySource = groupBy === "source";

  // Left list: aggregate by the chosen dimension (source or tour).
  const leftItems = useMemo(() => {
    const map = new Map<
      string,
      { name: string; pax: number; bookings: number; color: string | null }
    >();
    for (const r of baseRows) {
      const key = groupingBySource ? r.source : r.tour;
      const cur = map.get(key) ?? {
        name: key,
        pax: 0,
        bookings: 0,
        color: r.color,
      };
      cur.pax += r.pax;
      cur.bookings += r.bookings;
      if (!groupingBySource && r.color) cur.color = r.color;
      map.set(key, cur);
    }
    let items = Array.from(map.values()).map((v) => ({
      ...v,
      type: classifySource(v.name),
    }));
    if (groupingBySource && typeFilter !== "all") {
      items = items.filter((i) => i.type === typeFilter);
    }
    return items.sort((a, b) => b.pax - a.pax);
  }, [baseRows, groupingBySource, typeFilter]);

  const active =
    leftItems.find((i) => i.name === selected) ?? leftItems[0] ?? null;

  // Right list: the opposite dimension, broken down for the active item.
  const rightItems = useMemo(() => {
    if (!active) return [];
    const map = new Map<
      string,
      { name: string; pax: number; bookings: number; color: string | null }
    >();
    for (const r of baseRows) {
      const matchKey = groupingBySource ? r.source : r.tour;
      if (matchKey !== active.name) continue;
      const key = groupingBySource ? r.tour : r.source;
      const cur = map.get(key) ?? {
        name: key,
        pax: 0,
        bookings: 0,
        color: r.color,
      };
      cur.pax += r.pax;
      cur.bookings += r.bookings;
      if (r.color) cur.color = r.color;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.pax - a.pax);
  }, [baseRows, active, groupingBySource]);

  const maxLeft = Math.max(1, ...leftItems.map((i) => i.pax));
  const maxRight = Math.max(1, ...rightItems.map((i) => i.pax));

  const presets = [
    { label: "This month", from: `${today.slice(0, 7)}-01`, to: today },
    { label: "Last 30 days", from: addDaysIso(today, -29), to: today },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];

  const leftTitle = groupingBySource ? "Sources" : "Tours";
  const rightTitle = groupingBySource ? "Tours sold" : "Sold by";

  const handleExport = () => {
    const header = ["Business", "Source", "Type", "Tour", "Pax", "Bookings"];
    const data = baseRows
      .slice()
      .sort((a, b) => b.pax - a.pax)
      .map((r) => [
        r.business,
        r.source,
        classifySource(r.source),
        r.tour,
        r.pax,
        r.bookings,
      ]);
    downloadCsv(`analytics-${from}_to_${to}.csv`, header, data);
  };

  const kpis = [
    { label: "Guests", value: totals.guests, sub: "in range" },
    { label: "Bookings", value: totals.bookings, sub: "in range" },
    {
      label: "OTA guests",
      value: totals.ota,
      sub: `${pct(totals.ota, totals.guests)}% of guests`,
    },
    {
      label: "Organic guests",
      value: totals.organic,
      sub: `${pct(totals.organic, totals.guests)}% of guests`,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Date range + presets + export */}
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          From
          <DateField
            value={from}
            onChange={(e) => e.target.value && setRange(e.target.value, to)}
            aria-label="From date"
            className="h-9 w-[10rem]"
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          To
          <DateField
            value={to}
            onChange={(e) => e.target.value && setRange(from, e.target.value)}
            aria-label="To date"
            className="h-9 w-[10rem]"
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const isActive = p.from === from && p.to === to;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => setRange(p.from, p.to)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                  isActive
                    ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={baseRows.length === 0}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="size-4" />
          Export CSV
        </button>
      </div>

      {/* Group-by + business filters */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Group by
          </span>
          <div className="flex gap-1">
            {(["source", "tour"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGroupBy(g)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium capitalize transition",
                  groupBy === g
                    ? "bg-indigo-600 text-white"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        {showBusinessFilter && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Business
            </span>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setBusinessFilter("all")}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition",
                  businessFilter === "all"
                    ? "bg-indigo-600 text-white"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                All
              </button>
              {businesses.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBusinessFilter(b.id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition",
                    businessFilter === b.id
                      ? "bg-indigo-600 text-white"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <p className="text-xs font-medium text-muted-foreground">
              {k.label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {k.value.toLocaleString()}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{k.sub}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Left: ranked dimension */}
        <Card className="min-w-0 p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">{leftTitle}</h2>
            {groupingBySource && (
              <div className="flex gap-1">
                {(["all", "ORGANIC", "OTA"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTypeFilter(t)}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium transition",
                      typeFilter === t
                        ? "bg-indigo-600 text-white"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {t === "all" ? "All" : t === "OTA" ? "OTA" : "Organic"}
                  </button>
                ))}
              </div>
            )}
          </div>

          {leftItems.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No bookings in this range.
            </p>
          ) : (
            <ol className="space-y-2">
              {leftItems.map((item, i) => {
                const isActive = active?.name === item.name;
                return (
                  <li key={item.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(item.name)}
                      className={cn(
                        "w-full rounded-xl border p-4 text-left transition",
                        isActive
                          ? "border-indigo-200 bg-indigo-50/50 ring-1 ring-indigo-200"
                          : "hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium text-muted-foreground">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="flex min-w-0 items-center gap-2 font-semibold">
                              {!groupingBySource && (
                                <span
                                  className="size-2.5 shrink-0 rounded-full"
                                  style={{
                                    background: item.color ?? "#4f46e5",
                                  }}
                                />
                              )}
                              <span className="truncate">{item.name}</span>
                            </p>
                            <span className="text-xl font-semibold tabular-nums">
                              {item.pax}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {item.pax} pax · {item.bookings} bookings
                            </span>
                            {groupingBySource && (
                              <Badge
                                tone={
                                  item.type === "OTA" ? "warning" : "success"
                                }
                              >
                                {item.type}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${(item.pax / maxLeft) * 100}%`,
                                background: groupingBySource
                                  ? "#4f46e5"
                                  : (item.color ?? "#4f46e5"),
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        {/* Right: opposite dimension for the active item */}
        <Card className="min-w-0 p-5">
          {!active ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Select a {groupBy} to break it down.
            </p>
          ) : (
            <>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {rightTitle}
              </p>
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight">
                  {!groupingBySource && (
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ background: active.color ?? "#4f46e5" }}
                    />
                  )}
                  <span className="truncate">{active.name}</span>
                </h2>
                {groupingBySource && (
                  <Badge tone={active.type === "OTA" ? "warning" : "success"}>
                    {active.type}
                  </Badge>
                )}
              </div>
              <ul className="space-y-2">
                {rightItems.map((item) => {
                  const itemType = classifySource(item.name);
                  return (
                    <li key={item.name} className="rounded-xl border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="flex min-w-0 items-center gap-2 font-medium">
                          {groupingBySource && item.color && (
                            <span
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ background: item.color }}
                            />
                          )}
                          <span className="truncate">{item.name}</span>
                        </p>
                        <span className="text-sm font-semibold tabular-nums">
                          {item.pax}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {item.pax} pax · {item.bookings} bookings
                        </span>
                        {!groupingBySource && (
                          <Badge
                            tone={itemType === "OTA" ? "warning" : "success"}
                          >
                            {itemType}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(item.pax / maxRight) * 100}%`,
                            background: groupingBySource
                              ? (item.color ?? "#4f46e5")
                              : "#4f46e5",
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
