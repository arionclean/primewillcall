"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  ChevronRight,
  Download,
  Info,
  LoaderCircle,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { cn } from "@/lib/utils";
import { BUSINESS_TZ, getLocalDateRange } from "@/lib/dates";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { classifySource } from "@/lib/source-type";
import type {
  DateBasis,
  KioskSourceTourRow,
  SourceTourRow,
} from "@/lib/dashboard/queries";

type AnalyticsViewProps = {
  /** Every source except the tablets. */
  rows: SourceTourRow[];
  /** The tablet sales, one row per kiosk x cash|card x product. */
  kioskRows: KioskSourceTourRow[];
  from: string;
  to: string;
  today: string;
  /** Which date the panel counts on: the departure, or the sale. */
  basis: DateBasis;
};

/** One row of either list: a source, a tour, or a kiosk's Cash / Card. */
type ListItem = {
  name: string;
  pax: number;
  bookings: number;
  color: string | null;
  type: "OTA" | "ORGANIC";
  /** Set on a kiosk row of the Sources list: it opens the Cash / Card column. */
  kioskSlug?: string;
  /** Set on the Cash / Card rows of the payment column. */
  payType?: "cash" | "card";
};

type TypeFilter = "all" | "ORGANIC" | "OTA";
type GroupBy = "source" | "tour";

/** One booking behind a source x tour cell (the last column). */
type BookingRow = {
  id: string;
  startsAt: string;
  customer: string;
  pax: number;
  status: string;
  createdAt: string;
};

/** A row as either bookings RPC returns it (both share this shape). */
type DetailRpcRow = {
  id: string;
  starts_at: string;
  customer: string;
  pax: number;
  status: string;
  created_at: string;
};

/* One segmented control, used by every filter in the bar so they read as one
   row of controls rather than a scatter of pills. */
const SEGMENT = "inline-flex items-center rounded-lg border bg-muted/40 p-0.5";
const SEGMENT_ITEM =
  "rounded-md px-2.5 py-1 text-xs font-medium transition whitespace-nowrap";
const SEGMENT_ON = "bg-background text-foreground shadow-sm";
const SEGMENT_OFF = "text-muted-foreground hover:text-foreground";

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

export function AnalyticsView({
  rows,
  kioskRows,
  from,
  to,
  today,
  basis,
}: AnalyticsViewProps) {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("source");
  const [businessFilter, setBusinessFilter] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);
  // Custom = the From / To pair is open. Otherwise the picker is one calendar
  // that selects a single day, plus the presets. Starts open only when the URL
  // already carries a range that no preset produces.
  const [custom, setCustom] = useState(
    () => from !== to && !isPresetRange(from, to, today),
  );
  // Last column: the bookings behind the clicked item of the right list. Any
  // change of range, business, grouping or left selection closes it (the pair it
  // described no longer exists), so every such handler also clears it.
  const [detail, setDetail] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<BookingRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Picking a kiosk in Sources opens a payment column; null there means the
  // products column shows the whole tablet, cash and card together.
  const [payType, setPayType] = useState<"cash" | "card" | null>(null);

  // The date range is shared by both tabs: it lives in the URL, and each panel
  // reads it as a prop. Which DATE the panel counts on is the tab, not the URL.
  const setRange = (f: string, t: string) => {
    setDetail(null);
    router.push(`/analytics?from=${f}&to=${t}`);
  };
  const select = (name: string) => {
    setSelected(name);
    setPayType(null);
    setDetail(null);
  };

  // Kiosk rows join the others as ordinary sources named after the tablet, so
  // the Sources list says "Miami kiosk (kiosk3)" instead of "Kiosk - Card". The
  // database already left them out of `rows`, so nothing is counted twice.
  const kioskAsSource: SourceTourRow[] = useMemo(
    () =>
      kioskRows.map((r) => ({
        source: r.kiosk,
        tour: r.tour,
        color: r.color,
        businessId: r.businessId,
        business: r.business,
        pax: r.pax,
        bookings: r.bookings,
      })),
    [kioskRows],
  );
  const allRows = useMemo(
    () => [...rows, ...kioskAsSource],
    [rows, kioskAsSource],
  );
  // Source name -> kiosk slug, so a click anywhere knows it is a tablet.
  const kioskSlugByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of kioskRows) map.set(r.kiosk, r.kioskSlug);
    return map;
  }, [kioskRows]);

  // Distinct businesses present in the data. Owners see 2+, managers see 1
  // (RLS already scopes the rows), so the filter only shows for owners.
  const businesses = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allRows) map.set(r.businessId, r.business);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allRows]);

  const showBusinessFilter = businesses.length > 1;

  // Rows scoped to the selected business.
  const baseRows = useMemo(
    () =>
      businessFilter === "all"
        ? allRows
        : allRows.filter((r) => r.businessId === businessFilter),
    [allRows, businessFilter],
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
  const leftItems: ListItem[] = useMemo(() => {
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
    let items: ListItem[] = Array.from(map.values()).map((v) => ({
      ...v,
      type: classifySource(v.name),
      kioskSlug: groupingBySource ? kioskSlugByName.get(v.name) : undefined,
    }));
    if (groupingBySource && typeFilter !== "all") {
      items = items.filter((i) => i.type === typeFilter);
    }
    return items.sort((a, b) => b.pax - a.pax);
  }, [baseRows, kioskSlugByName, groupingBySource, typeFilter]);

  const active =
    leftItems.find((i) => i.name === selected) ?? leftItems[0] ?? null;

  // The selected source is a tablet: its own column of Cash / Card sits between
  // the sources and the products.
  const activeKioskSlug = active?.kioskSlug ?? null;

  // The kiosk's rows, scoped to the chosen business.
  const kioskScoped = useMemo(
    () =>
      !activeKioskSlug
        ? []
        : kioskRows.filter(
            (r) =>
              r.kioskSlug === activeKioskSlug &&
              (businessFilter === "all" || r.businessId === businessFilter),
          ),
    [kioskRows, activeKioskSlug, businessFilter],
  );

  // Payment column: Cash and Card for the selected kiosk.
  const payItems: ListItem[] = useMemo(() => {
    const map = new Map<string, ListItem>();
    for (const r of kioskScoped) {
      const name = r.payType === "cash" ? "Cash" : "Card";
      const cur = map.get(name) ?? {
        name,
        pax: 0,
        bookings: 0,
        color: null,
        type: "ORGANIC" as const,
        payType: r.payType,
      };
      cur.pax += r.pax;
      cur.bookings += r.bookings;
      map.set(name, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.pax - a.pax);
  }, [kioskScoped]);

  // Right list: the kiosk's products (all of them, or just the payment picked),
  // else the opposite dimension of the active item.
  const rightItems: ListItem[] = useMemo(() => {
    if (!active) return [];
    const map = new Map<string, ListItem>();
    if (activeKioskSlug) {
      for (const r of kioskScoped) {
        if (payType && r.payType !== payType) continue;
        const cur = map.get(r.tour) ?? {
          name: r.tour,
          pax: 0,
          bookings: 0,
          color: r.color,
          type: "ORGANIC" as const,
        };
        cur.pax += r.pax;
        cur.bookings += r.bookings;
        if (r.color) cur.color = r.color;
        map.set(r.tour, cur);
      }
      return Array.from(map.values()).sort((a, b) => b.pax - a.pax);
    }
    for (const r of baseRows) {
      const matchKey = groupingBySource ? r.source : r.tour;
      if (matchKey !== active.name) continue;
      const key = groupingBySource ? r.tour : r.source;
      const cur = map.get(key) ?? {
        name: key,
        pax: 0,
        bookings: 0,
        color: r.color,
        type: classifySource(key),
      };
      cur.pax += r.pax;
      cur.bookings += r.bookings;
      if (r.color) cur.color = r.color;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.pax - a.pax);
  }, [
    baseRows,
    kioskScoped,
    activeKioskSlug,
    payType,
    active,
    groupingBySource,
  ]);

  const maxPay = Math.max(1, ...payItems.map((i) => i.pax));
  const maxLeft = Math.max(1, ...leftItems.map((i) => i.pax));

  // The pair the last column describes. The products list holds the opposite
  // dimension of the left one, so the clicked name is a tour when grouping by
  // source and a source when grouping by tour. For a kiosk it is that tablet,
  // narrowed to Cash or Card when one is picked, against the product.
  const activeName = active?.name ?? null;
  const detailSource = activeKioskSlug
    ? `${activeName ?? ""}${payType ? ` · ${payType === "cash" ? "Cash" : "Card"}` : ""}`
    : groupingBySource
      ? activeName
      : detail;
  const detailTour = groupingBySource ? detail : activeName;
  // A kiosk cannot be found by source name (the name is the tablet's, not a
  // channel), so its bookings come from the kiosk RPC instead.
  const detailKioskSlug =
    activeKioskSlug ??
    (groupingBySource ? null : (kioskSlugByName.get(detail ?? "") ?? null));
  const detailPayType = activeKioskSlug ? payType : null;
  // The tour's colour ties the clicked middle item to the third column. It is
  // the right item when grouping by source, the left one when grouping by tour.
  const detailColor =
    (groupingBySource
      ? rightItems.find((i) => i.name === detail)?.color
      : active?.color) ?? "#4f46e5";

  // How many cards sit side by side: sources, the kiosk's payment split when a
  // tablet is selected, the products, and the bookings once one is clicked.
  const showPayColumn = Boolean(activeKioskSlug);
  const showDetail = Boolean(detail && detailSource && detailTour);
  const columns = 2 + (showPayColumn ? 1 : 0) + (showDetail ? 1 : 0);

  // Four columns scroll sideways, so bring the bookings into view when they
  // open instead of leaving them off the right edge. A no-op while the cards
  // are stacked, since there is nothing to scroll.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showDetail || columns < 4) return;
    const el = scrollerRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [showDetail, columns, detail]);

  useEffect(() => {
    if (!detail || !detailSource || !detailTour) return;
    let cancelled = false;
    setDetailLoading(true);
    const sb = getSupabaseBrowserClient();
    const range = {
      p_start: getLocalDateRange(from, BUSINESS_TZ).startUtc,
      p_end: getLocalDateRange(to, BUSINESS_TZ).endUtcExclusive,
      p_business_id: businessFilter === "all" ? undefined : businessFilter,
    };
    void (async () => {
      const { data } = detailKioskSlug
        ? await sb.rpc("analytics_kiosk_bookings", {
            ...range,
            p_kiosk_slug: detailKioskSlug,
            p_pay_type: detailPayType ?? undefined,
            p_tour: detailTour,
            p_basis: basis,
          })
        : await sb.rpc("analytics_bookings", {
            ...range,
            p_source: detailSource,
            p_tour: detailTour,
            p_basis: basis,
          });
      if (cancelled) return;
      const list: DetailRpcRow[] = data ?? [];
      setDetailRows(
        list.map((r) => ({
          id: r.id,
          startsAt: r.starts_at,
          customer: r.customer,
          pax: Number(r.pax),
          status: r.status,
          createdAt: r.created_at,
        })),
      );
      setDetailLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    detail,
    detailSource,
    detailTour,
    detailKioskSlug,
    detailPayType,
    from,
    to,
    basis,
    businessFilter,
  ]);
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

  // Bookings first: it is the count of reservations, and guests follow from it.
  // The two headline cards carry no caption. "in range" said nothing the date
  // filter above them had not already said.
  const kpis = [
    { label: "Bookings", value: totals.bookings, sub: null },
    { label: "Guests", value: totals.guests, sub: null },
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
      {/* The two tabs look identical and count different things, so the
          difference gets a callout rather than a caption. One line, one colour:
          this is an explanation, not a status, and a second colour would read as
          if it meant something. */}
      <div className="flex items-center gap-2.5 rounded-lg border border-blue-200 border-l-4 border-l-blue-500 bg-blue-50/60 px-3 py-2 dark:border-blue-900 dark:border-l-blue-500 dark:bg-blue-950/30">
        <Info className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <p className="text-sm text-blue-900 dark:text-blue-200">
          <span className="font-semibold">
            {basis === "sale" ? "Sales" : "Departures"}
          </span>
          <span className="text-blue-900/70 dark:text-blue-200/70">
            {basis === "sale"
              ? " counts a booking on the day it was bought."
              : " counts a booking on the day the tour happens."}
          </span>
        </p>
      </div>

      {/*
        One filter bar, not three rows of chips. The date and its presets sit in
        a single segmented control; grouping and business follow on the same
        line and wrap only when they must. The date field carries no label: the
        tab above already says whether this is Sales or Departures, so a
        "Sale date" caption was repeating it.
      */}
      <div className="flex flex-wrap items-center gap-2">
        {custom ? (
          <div className="inline-flex items-center gap-1.5">
            <DateField
              value={from}
              onChange={(e) => e.target.value && setRange(e.target.value, to)}
              aria-label="From date"
              className="h-8 w-[9rem] text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <DateField
              value={to}
              onChange={(e) => e.target.value && setRange(from, e.target.value)}
              aria-label="To date"
              className="h-8 w-[9rem] text-xs"
            />
          </div>
        ) : (
          <DateField
            value={from === to ? from : ""}
            onChange={(e) => {
              const day = e.target.value;
              if (day) setRange(day, day);
            }}
            aria-label={basis === "sale" ? "Sale date" : "Departure date"}
            className="h-8 w-[9rem] text-xs"
          />
        )}

        <div className={SEGMENT}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setCustom(false);
                setRange(p.from, p.to);
              }}
              className={cn(
                SEGMENT_ITEM,
                !custom && p.from === from && p.to === to
                  ? SEGMENT_ON
                  : SEGMENT_OFF,
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustom(true)}
            className={cn(SEGMENT_ITEM, custom ? SEGMENT_ON : SEGMENT_OFF)}
          >
            Custom
          </button>
        </div>

        <span className="hidden h-5 w-px bg-border sm:block" />

        <div className={SEGMENT}>
          {(["source", "tour"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                setGroupBy(g);
                setSelected(null);
                setPayType(null);
                setDetail(null);
              }}
              className={cn(
                SEGMENT_ITEM,
                "capitalize",
                groupBy === g ? SEGMENT_ON : SEGMENT_OFF,
              )}
            >
              By {g}
            </button>
          ))}
        </div>

        {groupingBySource && (
          <div className={SEGMENT}>
            {(["all", "ORGANIC", "OTA"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTypeFilter(t);
                  setPayType(null);
                  setDetail(null);
                }}
                className={cn(
                  SEGMENT_ITEM,
                  typeFilter === t ? SEGMENT_ON : SEGMENT_OFF,
                )}
              >
                {t === "all" ? "All sources" : t === "OTA" ? "OTA" : "Organic"}
              </button>
            ))}
          </div>
        )}

        {showBusinessFilter && (
          <div className={SEGMENT}>
            <button
              type="button"
              onClick={() => {
                setBusinessFilter("all");
                setDetail(null);
              }}
              className={cn(
                SEGMENT_ITEM,
                businessFilter === "all" ? SEGMENT_ON : SEGMENT_OFF,
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
                  SEGMENT_ITEM,
                  businessFilter === b.id ? SEGMENT_ON : SEGMENT_OFF,
                )}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={baseRows.length === 0}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="size-3.5" />
          Export
        </button>
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
            {k.sub && (
              <p className="mt-0.5 text-xs text-muted-foreground">{k.sub}</p>
            )}
          </Card>
        ))}
      </div>

      {/* Sources, then the kiosk's Cash / Card, then products, then the
          bookings. Four columns rarely fit a screen, so that case becomes one
          row that scrolls sideways instead of wrapping the bookings out of
          sight. Below lg everything stacks, as it always did. */}
      <div
        ref={scrollerRef}
        className={cn(columns === 4 && "-mx-1 overflow-x-auto px-1 pb-2")}
      >
        <div
          className={cn(
            "grid grid-cols-1 gap-5",
            columns === 4
              ? "lg:w-max lg:auto-cols-[21rem] lg:grid-flow-col lg:grid-cols-none"
              : cn("lg:grid-cols-2", columns === 3 && "xl:grid-cols-3"),
          )}
        >
          {/* Left: ranked dimension */}
          <Card className="min-w-0 p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                {leftTitle}
              </h2>
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
                                {item.kioskSlug && (
                                  <ChevronRight
                                    aria-hidden
                                    className="size-4 shrink-0 text-muted-foreground"
                                  />
                                )}
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

          {/* Payment: the selected kiosk's cash and card. Clicking one narrows
            the products list; clicking it again puts both back. */}
          {showPayColumn && (
            <Card className="min-w-0 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="shrink-0 text-lg font-semibold tracking-tight">
                  Payment
                </h2>
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {activeName}
                </span>
              </div>
              {payItems.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No kiosk sales in this range.
                </p>
              ) : (
                <ul className="space-y-2">
                  {payItems.map((item) => {
                    const isOn = payType === item.payType;
                    return (
                      <li key={item.name}>
                        <button
                          type="button"
                          onClick={() => {
                            setPayType(isOn ? null : (item.payType ?? null));
                            setDetail(null);
                          }}
                          aria-pressed={isOn}
                          className={cn(
                            "w-full rounded-xl border p-4 text-left transition",
                            isOn
                              ? "border-indigo-200 bg-indigo-50/50 ring-1 ring-indigo-200"
                              : "hover:bg-muted/40",
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate font-semibold">
                              {item.name}
                            </p>
                            <span className="text-xl font-semibold tabular-nums">
                              {item.pax}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.pax} pax · {item.bookings} bookings
                          </p>
                          <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${(item.pax / maxPay) * 100}%`,
                                background: "#4f46e5",
                              }}
                            />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          )}

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
                    <span className="truncate">
                      {detailSource ?? active.name}
                    </span>
                    {groupingBySource && !activeKioskSlug && (
                      <Badge
                        tone={active.type === "OTA" ? "warning" : "success"}
                      >
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
                                tone={
                                  itemType === "OTA" ? "warning" : "success"
                                }
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

          {/* Last: the bookings behind the clicked product */}
          {showDetail && (
            <Card
              className="min-w-0 p-5"
              style={{
                borderColor: `color-mix(in srgb, ${detailColor} 45%, transparent)`,
              }}
            >
              {/* Same header shape as the other columns: title left, the thing
                  it is showing muted on the right. */}
              <div className="mb-1 flex items-center justify-between gap-3">
                <h2 className="shrink-0 text-lg font-semibold tracking-tight">
                  Bookings
                </h2>
                <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: detailColor }}
                  />
                  <span className="truncate">{detailTour}</span>
                  <button
                    type="button"
                    onClick={() => setDetail(null)}
                    aria-label="Close bookings"
                    className="-mr-1 shrink-0 rounded-md p-1 transition hover:bg-muted"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
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
                  Showing the first {DETAIL_CAP}. Pick a shorter range to see
                  the rest.
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
