"use client";

import { useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { EVENT_GROUPS, eventDetail, eventLabel, PERSON_EVENTS, type EventGroup } from "@/lib/kiosk/events";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type ActivityRow = {
  id: number;
  at: string;
  event: string;
  level: string;
  ref: string | null;
  payload: Record<string, unknown> | null;
  kioskSlug: string | null;
  employeeId: string | null;
  employeeName: string | null;
  appBuild: string | null;
};

/** The filter as the page resolved it from the URL: what the database was asked. */
export type ActivityFilter = {
  day: string; // local YYYY-MM-DD
  isToday: boolean;
  startUtc: string;
  endUtcExclusive: string;
  employee: string;
  kiosk: string;
  group: EventGroup | "";
  /** Tablet housekeeping (debug rows) shows only when that group is picked. */
  includeDebug: boolean;
};

export type PersonOption = { id: string; name: string };
export type KioskOption = { id: string; slug: string; name: string };

type Props = {
  rows: ActivityRow[];
  total: number;
  pageSize: number;
  filter: ActivityFilter;
  employees: PersonOption[];
  kiosks: KioskOption[];
  loadError: boolean;
};

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** The same test the database applied, for rows that arrive live. */
function matches(row: ActivityRow, f: ActivityFilter): boolean {
  const t = new Date(row.at).getTime();
  if (t < new Date(f.startUtc).getTime() || t >= new Date(f.endUtcExclusive).getTime()) return false;
  if (f.employee && row.employeeId !== f.employee) return false;
  if (f.kiosk && row.kioskSlug !== f.kiosk) return false;
  if (f.group && !(EVENT_GROUPS[f.group].events as readonly string[]).includes(row.event)) return false;
  if (!f.includeDebug && row.level === "debug") return false;
  return true;
}

function rpcArgs(f: ActivityFilter) {
  return {
    p_from: f.startUtc,
    p_to: f.endUtcExclusive,
    p_employee: f.employee || undefined,
    p_kiosk: f.kiosk || undefined,
    p_events: f.group ? [...EVENT_GROUPS[f.group].events] : undefined,
    p_include_debug: f.includeDebug,
  };
}

function toRow(r: {
  id: number;
  at: string;
  event: string;
  level: string;
  ref: string | null;
  payload: unknown;
  kiosk_slug: string | null;
  employee_id: string | null;
  employee_name: string | null;
  app_build: string | null;
}): ActivityRow {
  return {
    id: r.id,
    at: r.at,
    event: r.event,
    level: r.level,
    ref: r.ref,
    payload: (r.payload as Record<string, unknown> | null) ?? null,
    kioskSlug: r.kiosk_slug,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    appBuild: r.app_build,
  };
}

/**
 * The activity log. The server rendered the first page for the filter in the URL;
 * this holds the rows, pages further back through the `kiosk_activity` RPC (keyset
 * on `at, id`, so page 40 costs what page 1 does), and, while the day is today,
 * prepends rows as the tablets post them (one Realtime INSERT subscription,
 * filtered here the same way the database filtered the page). Nothing here
 * re-renders the rest of the page.
 */
export function ActivityFeed({ rows: initialRows, total: initialTotal, pageSize, filter, employees, kiosks, loadError }: Props) {
  const [rows, setRows] = useState<ActivityRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [hasMore, setHasMore] = useState(initialRows.length >= pageSize);
  const [loading, setLoading] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // A new server render (filters changed) replaces what is held here.
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    setRows(initialRows);
    setTotal(initialTotal);
    setHasMore(initialRows.length >= pageSize);
    setLoadMoreError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const live = new Date(filter.endUtcExclusive).getTime() > Date.now();
  const filtered = Boolean(filter.employee || filter.kiosk || filter.group) || !filter.isToday;

  useEffect(() => {
    if (!live) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel("employees-activity-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "kiosk_events" }, (msg) => {
        const row = toRow(msg.new as Parameters<typeof toRow>[0]);
        if (!matches(row, filterRef.current)) return;
        setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
        setTotal((n) => n + 1);
      })
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error(`[realtime] employees-activity-feed ${status}`, err ?? "");
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [live]);

  async function loadMore() {
    const last = rows[rows.length - 1];
    if (!last || loading) return;
    setLoading(true);
    setLoadMoreError(false);
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.rpc("kiosk_activity", {
      ...rpcArgs(filterRef.current),
      p_before_at: last.at,
      p_before_id: last.id,
      p_limit: pageSize,
    });
    setLoading(false);
    if (error) {
      console.error("[employees] load more:", error);
      setLoadMoreError(true);
      return;
    }
    const more = (data ?? []).map(toRow);
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...prev, ...more.filter((r) => !seen.has(r.id))];
    });
    setHasMore(more.length >= pageSize);
  }

  return (
    <section id="activity" className="space-y-3">
      <div className="px-1">
        <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What the tablets recorded that day, newest first.
          {live ? " New actions appear as they happen." : ""}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          {/* No Show button: picking a value applies it. */}
          <form
            method="get"
            action="#activity"
            onChange={(e) => e.currentTarget.requestSubmit()}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            <Field label="Day" htmlFor="act-day">
              <DateField id="act-day" name="day" defaultValue={filter.day} />
            </Field>
            <Field label="Employee" htmlFor="act-emp">
              <Select id="act-emp" name="employee" defaultValue={filter.employee}>
                <option value="">Everyone</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tablet" htmlFor="act-kiosk">
              <Select id="act-kiosk" name="kiosk" defaultValue={filter.kiosk}>
                <option value="">All tablets</option>
                {kiosks.map((k) => (
                  <option key={k.id} value={k.slug}>
                    {k.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Action" htmlFor="act-group">
              <Select id="act-group" name="group" defaultValue={filter.group}>
                <option value="">All actions</option>
                {(Object.keys(EVENT_GROUPS) as EventGroup[]).map((g) => (
                  <option key={g} value={g}>
                    {EVENT_GROUPS[g].label}
                  </option>
                ))}
              </Select>
            </Field>
            {filtered && (
              <div className="flex items-end">
                <a href="?#activity" className={buttonVariants({ variant: "ghost" })}>
                  Reset
                </a>
              </div>
            )}
          </form>

          {loadError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Could not load the activity. Refresh the page and try again.
            </p>
          )}

          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
              Nothing recorded for this selection.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium">Who</th>
                    <th className="py-2 pr-3 font-medium">Tablet</th>
                    <th className="py-2 pr-3 font-medium">What</th>
                    <th className="py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((a) => {
                    const person = PERSON_EVENTS.has(a.event);
                    const detail = [eventDetail(a.event, a.payload), a.ref].filter(Boolean).join(" · ");
                    return (
                      <tr
                        key={a.id}
                        className={a.level === "error" ? "bg-red-50/60 dark:bg-red-950/20" : a.level === "warn" ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}
                      >
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-muted-foreground">{timeFmt.format(new Date(a.at))}</td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {a.employeeName ? (
                            <span className={person ? "font-medium" : ""}>{a.employeeName}</span>
                          ) : (
                            <span className="text-muted-foreground">Tablet</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{a.kioskSlug ?? ""}</td>
                        <td className="py-2 pr-3">{eventLabel(a.event)}</td>
                        <td className="py-2 text-muted-foreground">{detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(hasMore || loadMoreError) && (
            <div className="flex items-center gap-3 border-t pt-3">
              <Button type="button" variant="outline" size="sm" onClick={loadMore} disabled={loading}>
                {loading ? "Loading" : "Load more"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Showing {rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
              </span>
              {loadMoreError && <span className="text-xs text-destructive">Could not load more. Try again.</span>}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
