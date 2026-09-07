"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Download, LoaderCircle, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { cn } from "@/lib/utils";
import { BUSINESS_TZ, getLocalDateRange } from "@/lib/dates";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
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

/** One booking behind a source x tour cell (the third column). */
type BookingRow = {
  id: string;
  startsAt: string;
  customer: string;
  pax: number;
  status: string;
  createdAt: string;
};

const DETAIL_CAP = 300; // matches the limit in the analytics_bookings RPC

const whenFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
// Day only, for the "Booked" tag.
const bookedFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  month: "short",
  day: "numeric",
});
// en-CA formats as YYYY-MM-DD, which is what /bookings?date= expects.
const ymdFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function addDaysIso(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when [from, to] is exactly one of the preset ranges for `today`. */
function isPresetRange(from: string, to: string, today: string): boolean {
  if (to !== today) return false;
  return (
    from === today ||
    from === `${today.slice(0, 7)}-01` ||
    from === addDaysIso(today, -29) ||
    from === `${today.slice(0, 4)}-01-01`
  );
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
  // Custom = the From / To pair is open. Otherwise the picker is one calendar
  // that selects a single day, plus the presets. Starts open only when the URL
  // already carries a range that no preset produces.
  const [custom, setCustom] = useState(() => from !== to && !isPresetRange(from, to, today));
  // Third column: the bookings behind the clicked item of the right list. Any
  // change of range, business, grouping or left selection closes it (the pair it
  // described no longer exists), so every such handler also clears it.
  const [detail, setDetail] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<BookingRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const setRange = (f: string, t: string) => {
    setDetail(null);
    router.push(`/analytics?from=${f}&to=${t}`);
  };
  const select = (name: string) => {
    setSelected(name);
    setDetail(null);
  };

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

  // The pair the third column describes. The right list holds the opposite
  // dimension of the left one, so the clicked name is a tour when grouping by
  // source and a source when grouping by tour.
  const activeName = active?.name ?? null;
  const detailSource = groupingBySource ? activeName : detail;
  const detailTour = groupingBySource ? detail : activeName;
  // The tour's colour ties the clicked middle item to the third column. It is
  // the right item when grouping by source, the left one when grouping by tour.
  const detailColor =
    (groupingBySource
      ? rightItems.find((i) => i.name === detail)?.color
      : active?.color) ?? "#4f46e5";

  useEffect(() => {
    if (!detail || !detailSource || !detailTour) return;
    let cancelled = false;
    setDetailLoading(true);
    const sb = getSupabaseBrowserClient();
    sb.rpc("analytics_bookings", {
      p_start: getLocalDateRange(from, BUSINESS_TZ).startUtc,
      p_end: getLocalDateRange(to, BUSINESS_TZ).endUtcExclusive,
      p_source: detailSource,
      p_tour: detailTour,
      p_business_id: businessFilter === "all" ? undefined : businessFilter,
    }).then(({ data }) => {
      if (cancelled) return;
      setDetailRows(
        (data ?? []).map((r) => ({
          id: r.id,
          startsAt: r.starts_at,
          customer: r.customer,
          pax: Number(r.pax),
          status: r.status,
          createdAt: r.created_at,
        })),
      );
      setDetailLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, detailSource, detailTour, from, to, businessFilter]);
  const maxRight = Math.max(1, ...rightItems.map((i) => i.pax));

  const presets = [
    { label: "Today", from: today, to: today },
    { label: "This month", from: `${today.slice(0, 7)}-01`, to: today },
    { label: "Last 30 days", from: addDaysIso(today, -29), to: today },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];

  const leftTitle = groupingBySource ? "Sources" : "Tours";
  const rightTitle = groupingBySource ? "Products sold" : "Sold by";

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
    downloadCsv(
      from === to ? `analytics-${from}.csv` : `analytics-${from}_to_${to}.csv`,
      header,
      data,
    );
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
      {/* Date: one calendar for a single day, presets, or a Custom From / To */}
      <div className="flex flex-wrap items-end gap-4">
        {custom ? (
          <>
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
          </>
        ) : (
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Date
            <DateField
              value={from === to ? from : ""}
              onChange={(e) => {
                const day = e.target.value;
                if (day) setRange(day, day);
              }}
              aria-label="Date"
              className="h-9 w-[10rem]"
            />
          </label>
        )}
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const isActive = !custom && p.from === from && p.to === to;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setCustom(false);
                  setRange(p.from, p.to);
                }}
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
          <button
            type="button"
            onClick={() => setCustom(true)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition",
              custom
                ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            Custom
          </button>
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
                onClick={() => {
                  setGroupBy(g);
                  setDetail(null);
                }}
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
                onClick={() => {
                  setBusinessFilter("all");
                  setDetail(null);
                }}
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
                  onClick={() => {
                    setBusinessFilter(b.id);
                    setDetail(null);
                  }}
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

      <div
        className={cn("grid gap-5 lg:grid-cols-2", detail && "xl:grid-cols-3")}
      >
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
                      onClick={() => select(item.name)}
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
              {/* Title left; the selected left item on the right, muted, with its tag */}
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="shrink-0 text-lg font-semibold tracking-tight">
                  {rightTitle}
                </h2>
                <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  {!groupingBySource && (
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: active.color ?? "#4f46e5" }}
                    />
                  )}
                  <span className="truncate">{active.name}</span>
                  {groupingBySource && (
                    <Badge tone={active.type === "OTA" ? "warning" : "success"}>
                      {active.type}
                    </Badge>
                  )}
                </div>
              </div>
              <ul className="space-y-2">
                {rightItems.map((item) => {
                  const itemType = classifySource(item.name);
                  return (
                    <li key={item.name}>
                      <button
                        type="button"
                        onClick={() =>
                          setDetail(detail === item.name ? null : item.name)
                        }
                        aria-pressed={detail === item.name}
                        className="w-full rounded-xl border p-4 text-left transition hover:bg-muted/50"
                        style={
                          detail === item.name
                            ? {
                                borderColor: detailColor,
                                background: `color-mix(in srgb, ${detailColor} 8%, transparent)`,
                              }
                            : undefined
                        }
                      >
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
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>

        {/* Third: the bookings behind the clicked right item */}
        {detail && detailSource && detailTour && (
          <Card
            className="min-w-0 p-5"
            style={{
              borderColor: `color-mix(in srgb, ${detailColor} 45%, transparent)`,
            }}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Bookings
              </p>
              <button
                type="button"
                onClick={() => setDetail(null)}
                aria-label="Close bookings"
                className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight">
              <span
                className="size-3 shrink-0 rounded-full"
                style={{ background: detailColor }}
              />
              <span className="truncate">{detailTour}</span>
            </h2>
            <p className="mb-4 flex items-center gap-1 truncate text-xs text-muted-foreground">
              {detailSource} ·{" "}
              {detailLoading ? (
                <>
                  <LoaderCircle aria-hidden className="size-3 animate-spin" />
                  <span className="sr-only">Loading</span>
                </>
              ) : (
                `${detailRows.length} booking${detailRows.length === 1 ? "" : "s"}`
              )}
            </p>
            {detailLoading && detailRows.length === 0 ? (
              <div className="flex justify-center py-10 text-muted-foreground">
                <LoaderCircle aria-hidden className="size-5 animate-spin" />
              </div>
            ) : !detailLoading && detailRows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No bookings to show.
              </p>
            ) : (
              <ul className={cn("space-y-2", detailLoading && "opacity-50")}>
                {detailRows.map((b) => {
                  const when = new Date(b.startsAt);
                  const extra =
                    b.status !== "confirmed" ? ` · ${b.status}` : "";
                  return (
                    <li key={b.id}>
                      <Link
                        href={`/bookings?date=${ymdFmt.format(when)}&booking=${b.id}`}
                        className="flex items-center justify-between gap-3 rounded-xl border border-l-4 p-3 transition hover:bg-muted/50"
                        style={{ borderLeftColor: detailColor }}
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{b.customer}</p>
                          <p className="text-xs text-muted-foreground">
                            {whenFmt.format(when)} · {b.pax} pax{extra}
                          </p>
                          <Badge tone="neutral" className="mt-1.5">
                            Booked {bookedFmt.format(new Date(b.createdAt))}
                          </Badge>
                        </div>
                        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {detailRows.length >= DETAIL_CAP && (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the first {DETAIL_CAP}. Pick a shorter range to see the rest.
              </p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
