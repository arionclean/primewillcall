"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { BUSINESS_TZ, monthStartUtc } from "@/lib/dates";
import type { DailyTourRow } from "@/lib/dashboard/queries";

export type TourChip = { id: string; label: string; color: string | null };

type MonthlyComparisonProps = {
  chips: TourChip[];
  initialYear: number;
  initialMonth: number; // 1-12
  initialCurrent: DailyTourRow[];
  initialPrevious: DailyTourRow[];
  today: string; // YYYY-MM-DD
};

type Metric = "pax" | "bookings";
type CompareTo = "prev_month" | "prev_year";
type View = "daily" | "cumulative";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

const CURRENT_COLOR = "#4f46e5"; // indigo-600
const LAST_COLOR = "#cbd5e1"; // slate-300

// ── Chart geometry (viewBox units; scales responsively) ───────────────────────
const W = 760;
const H = 320;
const PAD_L = 44;
const PAD_R = 18;
const PAD_T = 24;
const PAD_B = 40;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

type RawDaily = {
  day: number;
  business_tour_id: string;
  tour: string;
  color: string | null;
  pax: number;
  bookings: number;
};

function mapRows(data: RawDaily[] | null): DailyTourRow[] {
  return (data ?? []).map((r) => ({
    day: Number(r.day),
    businessTourId: r.business_tour_id,
    tour: r.tour,
    color: r.color,
    pax: Number(r.pax),
    bookings: Number(r.bookings),
  }));
}

/** A "nice" axis max + tick step aiming for ~7 gridlines. */
function niceScale(maxVal: number): { max: number; step: number } {
  if (maxVal <= 0) return { max: 10, step: 5 };
  const rough = maxVal / 7;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const n = rough / base;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * base;
  return { max: Math.ceil(maxVal / step) * step, step };
}

/** Catmull-Rom spline through the points, emitted as a smooth cubic-bezier path. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function pctChange(a: number, b: number): number | null {
  return b > 0 ? Math.round(((a - b) / b) * 100) : null;
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null)
    return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Badge tone={value >= 0 ? "success" : "danger"}>
      {value > 0 ? "+" : ""}
      {value}%
    </Badge>
  );
}

/** Small pill segmented control. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition",
              value === o.value
                ? "bg-indigo-600 text-white"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MonthlyComparison({
  chips,
  initialYear,
  initialMonth,
  initialCurrent,
  initialPrevious,
  today,
}: MonthlyComparisonProps) {
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [current, setCurrent] = useState<DailyTourRow[]>(initialCurrent);
  const [previous, setPrevious] = useState<DailyTourRow[]>(initialPrevious);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(chips.map((c) => c.id)),
  );
  const [hovered, setHovered] = useState<number | null>(null);

  // Comparison tools.
  const [metric, setMetric] = useState<Metric>("pax");
  const [compareTo, setCompareTo] = useState<CompareTo>("prev_month");
  const [view, setView] = useState<View>("daily");

  // Refetch when month/year or the comparison baseline changes (initial month +
  // previous month are server-rendered, so the first render does not refetch).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHovered(null); // a stale index could point past the new range's days
    const sb = getSupabaseBrowserClient();

    const curStart = monthStartUtc(year, month);
    const nextStart = monthStartUtc(
      month === 12 ? year + 1 : year,
      month === 12 ? 1 : month + 1,
    );
    let cmpStart: string;
    let cmpEnd: string;
    if (compareTo === "prev_year") {
      const py = year - 1;
      cmpStart = monthStartUtc(py, month);
      cmpEnd = monthStartUtc(
        month === 12 ? py + 1 : py,
        month === 12 ? 1 : month + 1,
      );
    } else {
      cmpStart = monthStartUtc(
        month === 1 ? year - 1 : year,
        month === 1 ? 12 : month - 1,
      );
      cmpEnd = curStart;
    }

    Promise.all([
      sb.rpc("analytics_daily_by_tour", {
        p_start: curStart,
        p_end: nextStart,
        p_tz: BUSINESS_TZ,
      }),
      sb.rpc("analytics_daily_by_tour", {
        p_start: cmpStart,
        p_end: cmpEnd,
        p_tz: BUSINESS_TZ,
      }),
    ]).then(([c, p]) => {
      if (cancelled) return;
      setCurrent(mapRows(c.data));
      setPrevious(mapRows(p.data));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [year, month, compareTo]);

  const allSelected = selectedIds.size === chips.length;

  const toggleChip = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // How many days to plot: month-to-date for the live month, else the full month.
  const isCurrentRealMonth = `${year}-${pad2(month)}` === today.slice(0, 7);
  const dim = daysInMonth(year, month);
  const lastDay = isCurrentRealMonth
    ? Math.min(Number(today.slice(8, 10)), dim)
    : dim;

  // Labels for the two series.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevMonthYear = month === 1 ? year - 1 : year;
  const curLabel = `${MONTHS_SHORT[month - 1]} ${year}`;
  const cmpLabel =
    compareTo === "prev_year"
      ? `${MONTHS_SHORT[month - 1]} ${year - 1}`
      : `${MONTHS_SHORT[prevMonth - 1]} ${prevMonthYear}`;
  const curMonthShort = MONTHS_SHORT[month - 1];
  const cmpMonthShort =
    compareTo === "prev_year" ? MONTHS_SHORT[month - 1] : MONTHS_SHORT[prevMonth - 1];

  // Sum the selected tours into a per-day array for each series, in the metric.
  const daily = useMemo(() => {
    const value = (r: DailyTourRow) => (metric === "pax" ? r.pax : r.bookings);
    const sum = (rows: DailyTourRow[]) => {
      const byDay = new Array(lastDay + 1).fill(0);
      for (const r of rows) {
        if (!selectedIds.has(r.businessTourId)) continue;
        if (r.day >= 1 && r.day <= lastDay) byDay[r.day] += value(r);
      }
      return byDay;
    };
    const cur = sum(current);
    const prev = sum(previous);
    return Array.from({ length: lastDay }, (_, i) => ({
      day: i + 1,
      cur: cur[i + 1],
      prev: prev[i + 1],
    }));
  }, [current, previous, selectedIds, lastDay, metric]);

  // The chart can show daily values or a running cumulative total.
  const chart = useMemo(() => {
    if (view !== "cumulative") return daily;
    let c = 0;
    let p = 0;
    return daily.map((d) => {
      c += d.cur;
      p += d.prev;
      return { day: d.day, cur: c, prev: p };
    });
  }, [daily, view]);

  const stats = useMemo(() => {
    const curVals = daily.map((s) => s.cur);
    const prevVals = daily.map((s) => s.prev);
    const activeCur = curVals.filter((v) => v > 0);
    const activePrev = prevVals.filter((v) => v > 0);
    return {
      totalCur: curVals.reduce((s, v) => s + v, 0),
      totalPrev: prevVals.reduce((s, v) => s + v, 0),
      lowestCur: activeCur.length ? Math.min(...activeCur) : 0,
      lowestPrev: activePrev.length ? Math.min(...activePrev) : 0,
      highestCur: curVals.length ? Math.max(...curVals) : 0,
      highestPrev: prevVals.length ? Math.max(...prevVals) : 0,
    };
  }, [daily]);

  const maxVal = Math.max(1, ...chart.map((s) => Math.max(s.cur, s.prev)));
  const { max: maxY, step } = niceScale(maxVal);

  const n = chart.length;
  const xFor = (i: number) =>
    n <= 1 ? PAD_L + INNER_W / 2 : PAD_L + (i / (n - 1)) * INNER_W;
  const yFor = (v: number) => PAD_T + INNER_H - (v / maxY) * INNER_H;

  const curPts = chart.map((s, i) => ({ x: xFor(i), y: yFor(s.cur) }));
  const prevPts = chart.map((s, i) => ({ x: xFor(i), y: yFor(s.prev) }));

  const ticks: number[] = [];
  for (let t = 0; t <= maxY + 0.001; t += step) ticks.push(Math.round(t));

  const labelStride = n <= 8 ? 1 : Math.ceil(n / 8);

  const hoveredPoint = hovered !== null ? chart[hovered] : null;
  const hoverPct = hoveredPoint
    ? pctChange(hoveredPoint.cur, hoveredPoint.prev)
    : null;

  const metricLabel = metric === "pax" ? "pax" : "bookings";

  return (
    <Card className="min-w-0 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Monthly comparison
        </h2>
        <button
          type="button"
          onClick={() =>
            setSelectedIds(
              allSelected ? new Set() : new Set(chips.map((c) => c.id)),
            )
          }
          className="text-xs font-medium text-indigo-600 hover:underline"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>

      {/* Product chips */}
      <div className="mb-4 flex flex-wrap gap-2">
        {chips.map((c) => {
          const on = selectedIds.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => toggleChip(c.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition",
                on
                  ? "bg-indigo-600 text-white"
                  : "border text-muted-foreground hover:bg-muted",
              )}
            >
              {on && <Check className="size-3.5" />}
              {c.label}
            </button>
          );
        })}
      </div>

      {/* Controls */}
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex gap-2">
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            aria-label="Month"
            className="h-9 rounded-md border bg-background px-3 text-sm font-medium"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label="Year"
            className="h-9 rounded-md border bg-background px-3 text-sm font-medium"
          >
            {Array.from({ length: 5 }, (_, i) => initialYear - 3 + i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Compare to
          </span>
          <select
            value={compareTo}
            onChange={(e) => setCompareTo(e.target.value as CompareTo)}
            aria-label="Compare to"
            className="h-9 rounded-md border bg-background px-3 text-sm font-medium"
          >
            <option value="prev_month">Previous month</option>
            <option value="prev_year">Same month last year</option>
          </select>
        </div>

        <Segmented
          label="Measure"
          value={metric}
          onChange={setMetric}
          options={[
            { value: "pax", label: "Pax" },
            { value: "bookings", label: "Bookings" },
          ]}
        />
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "daily", label: "Daily" },
            { value: "cumulative", label: "Cumulative" },
          ]}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Chart */}
        <div className="min-w-0">
          {/* Legend */}
          <div className="mb-2 flex items-center justify-center gap-6 text-sm">
            <span className="inline-flex items-center gap-2">
              <span
                className="size-3 rounded-full"
                style={{ background: CURRENT_COLOR }}
              />
              {curLabel}
            </span>
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <span
                className="size-3 rounded-full"
                style={{ background: LAST_COLOR }}
              />
              {cmpLabel}
            </span>
          </div>

          <div className="relative">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className={cn(
                "h-auto w-full transition-opacity",
                loading && "opacity-40",
              )}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Gridlines + y labels */}
              {ticks.map((t) => {
                const y = yFor(t);
                return (
                  <g key={t}>
                    <line
                      x1={PAD_L}
                      x2={W - PAD_R}
                      y1={y}
                      y2={y}
                      stroke="currentColor"
                      className="text-border"
                      strokeWidth={1}
                    />
                    <text
                      x={PAD_L - 8}
                      y={y + 4}
                      textAnchor="end"
                      className="fill-muted-foreground text-[11px]"
                    >
                      {t}
                    </text>
                  </g>
                );
              })}

              {/* X labels */}
              {chart.map((s, i) =>
                i % labelStride === 0 || i === n - 1 ? (
                  <text
                    key={s.day}
                    x={xFor(i)}
                    y={H - PAD_B + 18}
                    textAnchor="end"
                    transform={`rotate(-45 ${xFor(i)} ${H - PAD_B + 18})`}
                    className="fill-muted-foreground text-[11px]"
                  >
                    {curMonthShort} {s.day}
                  </text>
                ) : null,
              )}

              {/* Lines (comparison behind current) */}
              {n > 0 && (
                <>
                  <path
                    d={smoothPath(prevPts)}
                    fill="none"
                    stroke={LAST_COLOR}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                  <path
                    d={smoothPath(curPts)}
                    fill="none"
                    stroke={CURRENT_COLOR}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                </>
              )}

              {/* Hover guide + dots */}
              {hovered !== null && curPts[hovered] && prevPts[hovered] && (
                <>
                  <line
                    x1={xFor(hovered)}
                    x2={xFor(hovered)}
                    y1={PAD_T}
                    y2={PAD_T + INNER_H}
                    stroke="currentColor"
                    className="text-border"
                    strokeWidth={1}
                  />
                  <circle
                    cx={prevPts[hovered].x}
                    cy={prevPts[hovered].y}
                    r={5}
                    fill={LAST_COLOR}
                  />
                  <circle
                    cx={curPts[hovered].x}
                    cy={curPts[hovered].y}
                    r={5}
                    fill={CURRENT_COLOR}
                  />
                </>
              )}

              {/* Invisible hover bands */}
              {chart.map((s, i) => {
                const spacing = n > 1 ? INNER_W / (n - 1) : INNER_W;
                return (
                  <rect
                    key={s.day}
                    x={xFor(i) - spacing / 2}
                    y={PAD_T}
                    width={spacing}
                    height={INNER_H}
                    fill="transparent"
                    onMouseEnter={() => setHovered(i)}
                  />
                );
              })}
            </svg>

            {/* Tooltip */}
            {hoveredPoint && (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[115%] whitespace-nowrap rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
                style={{
                  left: `${(xFor(hovered as number) / W) * 100}%`,
                  top: `${(Math.min(
                    curPts[hovered as number].y,
                    prevPts[hovered as number].y,
                  ) /
                    H) *
                    100}%`,
                }}
              >
                {hoverPct !== null && (
                  <div className="mb-1 font-medium">
                    {hoverPct > 0 ? "+" : ""}
                    {hoverPct}%
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-sm"
                      style={{ background: CURRENT_COLOR }}
                    />
                    {curMonthShort} {hoveredPoint.day}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {hoveredPoint.cur}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-4 text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-sm"
                      style={{ background: LAST_COLOR }}
                    />
                    {cmpMonthShort} {hoveredPoint.day}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {hoveredPoint.prev}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Stats */}
        <div>
          <div className="mb-4 flex items-center gap-3">
            <h3 className="text-lg font-semibold tracking-tight">
              {compareTo === "prev_year" ? "Year-over-year" : "Monthly change"}
            </h3>
            <DeltaBadge value={pctChange(stats.totalCur, stats.totalPrev)} />
          </div>

          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 gap-y-3 text-sm">
            <span />
            <span className="text-right text-xs font-medium text-muted-foreground">
              Total {metricLabel}
            </span>
            <span className="text-right text-xs font-medium text-muted-foreground">
              Lowest day
            </span>
            <span className="text-right text-xs font-medium text-muted-foreground">
              Highest day
            </span>

            <span className="flex items-center gap-2 font-medium">
              <span
                className="size-2.5 rounded-full"
                style={{ background: CURRENT_COLOR }}
              />
              {curLabel}
            </span>
            <span className="text-right font-semibold tabular-nums">
              {stats.totalCur.toLocaleString()}
            </span>
            <span className="text-right font-semibold tabular-nums">
              {stats.lowestCur.toLocaleString()}
            </span>
            <span className="text-right font-semibold tabular-nums">
              {stats.highestCur.toLocaleString()}
            </span>

            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className="size-2.5 rounded-full"
                style={{ background: LAST_COLOR }}
              />
              {cmpLabel}
            </span>
            <span className="text-right font-semibold tabular-nums text-muted-foreground">
              {stats.totalPrev.toLocaleString()}
            </span>
            <span className="text-right font-semibold tabular-nums text-muted-foreground">
              {stats.lowestPrev.toLocaleString()}
            </span>
            <span className="text-right font-semibold tabular-nums text-muted-foreground">
              {stats.highestPrev.toLocaleString()}
            </span>

            <span />
            <span className="text-right">
              <DeltaBadge value={pctChange(stats.totalCur, stats.totalPrev)} />
            </span>
            <span className="text-right">
              <DeltaBadge value={pctChange(stats.lowestCur, stats.lowestPrev)} />
            </span>
            <span className="text-right">
              <DeltaBadge
                value={pctChange(stats.highestCur, stats.highestPrev)}
              />
            </span>
          </div>

          {view === "cumulative" && (
            <p className="mt-4 text-xs text-muted-foreground">
              Lines show the running total through each day (month-to-date
              pacing). The table figures stay daily.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
