"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { EVENT_GROUPS, eventDetail, eventLabel, isPersonEvent, type EventGroup } from "@/lib/kiosk/events";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

import {
  personParts,
  rpcArgs,
  toRow,
  type ActivityFilter,
  type ActivityRow,
  type KioskOption,
  type PersonOption,
} from "./activity-shared";
import { liveChannelName } from "@/lib/realtime/channel-name";

type Props = {
  rows: ActivityRow[];
  pageSize: number;
  filter: ActivityFilter;
  people: PersonOption[];
  accounts: PersonOption[];
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
  if (f.source && row.source !== f.source) return false;
  const who = personParts(f.person);
  if (who.employee || who.staff) {
    const mine =
      (who.employee && row.employeeId === who.employee) || (who.staff && row.actorStaffId === who.staff);
    if (!mine) return false;
  }
  if (f.kiosk && row.kioskSlug !== f.kiosk) return false;
  if (f.group && !(EVENT_GROUPS[f.group].events as readonly string[]).includes(row.event)) return false;
  if (!f.includeDebug && row.level === "debug") return false;
  return true;
}

/**
 * The activity log, tablets and web in one stream. The server rendered the first
 * page for the filter in the URL; this holds the rows, pages further back through
 * the `activity_feed` RPC (keyset on `at, key`, so page 40 costs what page 1 does),
 * and, while the day is today, prepends rows as they land (one Realtime INSERT
 * subscription per source, filtered here the same way the database filtered the
 * page). Nothing here re-renders the rest of the page.
 */
export function ActivityFeed({ rows: initialRows, pageSize, filter, people, accounts, kiosks, loadError }: Props) {
  const [rows, setRows] = useState<ActivityRow[]>(initialRows);
  const [hasMore, setHasMore] = useState(initialRows.length >= pageSize);
  const [loading, setLoading] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // Live web rows carry the login's id, not its name; the people list knows it.
  const accountName = useRef(new Map<string, string>());
  accountName.current = new Map(
    accounts.flatMap((a) => {
      const staffId = personParts(a.value).staff;
      return staffId ? [[staffId, a.name] as [string, string]] : [];
    }),
  );

  // A new server render (filters changed) replaces what is held here.
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    setRows(initialRows);
    setHasMore(initialRows.length >= pageSize);
    setLoadMoreError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const live = new Date(filter.endUtcExclusive).getTime() > Date.now();
  const filtered = Boolean(filter.source || filter.person || filter.kiosk || filter.group) || !filter.isToday;

  useEffect(() => {
    if (!live) return;
    const supabase = getSupabaseBrowserClient();
    const add = (row: ActivityRow) => {
      if (!matches(row, filterRef.current)) return;
      setRows((prev) => (prev.some((r) => r.key === row.key) ? prev : [row, ...prev]));
    };
    const channel = supabase
      .channel(liveChannelName("employees-activity-feed"))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "kiosk_events" }, (msg) => {
        const n = msg.new as Record<string, unknown>;
        add(
          toRow({
            key: `tablet:${String(n.id).padStart(14, "0")}`,
            source: "tablet",
            at: String(n.at),
            event: String(n.event),
            level: String(n.level ?? "info"),
            ref: (n.ref as string | null) ?? null,
            payload: n.payload,
            kiosk_slug: (n.kiosk_slug as string | null) ?? null,
            employee_id: (n.employee_id as string | null) ?? null,
            employee_name: (n.employee_name as string | null) ?? null,
            actor_staff_id: null,
            actor_name: null,
            changed: [],
          }),
        );
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "audit_log" }, (msg) => {
        const n = msg.new as Record<string, unknown>;
        const staffId = (n.actor_staff_id as string | null) ?? null;
        add(
          toRow({
            key: `web:${String(n.id).padStart(14, "0")}`,
            source: "web",
            at: String(n.occurred_at),
            event: `${String(n.entity)}.${String(n.action)}`,
            level: n.action === "wrong_pin" ? "warn" : "info",
            ref: ((n.payload as Record<string, unknown> | null)?.ref as string | null) ?? null,
            payload: n.payload,
            kiosk_slug: null,
            employee_id: (n.employee_id as string | null) ?? null,
            employee_name: (n.employee_name as string | null) ?? null,
            actor_staff_id: staffId,
            actor_name: staffId ? (accountName.current.get(staffId) ?? null) : null,
            changed: (n.changed as string[] | null) ?? [],
          }),
        );
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
    const { data, error } = await supabase.rpc("activity_feed", {
      ...rpcArgs(filterRef.current),
      p_before_at: last.at,
      p_before_key: last.key,
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
      const seen = new Set(prev.map((r) => r.key));
      return [...prev, ...more.filter((r) => !seen.has(r.key))];
    });
    setHasMore(more.length >= pageSize);
  }

  return (
    <section id="activity" className="space-y-3">
      <Card>
        <CardContent className="space-y-4 py-5">
          {/* No Show button: picking a value applies it. */}
          <form
            method="get"
            action="/admin/staff/activity"
            onChange={(e) => e.currentTarget.requestSubmit()}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
          >
            <Field label="Day" htmlFor="act-day">
              <DateField id="act-day" name="day" defaultValue={filter.day} />
            </Field>
            <Field label="Where" htmlFor="act-source">
              <Select id="act-source" name="source" defaultValue={filter.source}>
                <option value="">Tablets and web</option>
                <option value="tablet">Tablets</option>
                <option value="web">Web</option>
              </Select>
            </Field>
            <Field label="Person" htmlFor="act-person">
              <Select id="act-person" name="person" defaultValue={filter.person}>
                <option value="">Everyone</option>
                {people.length > 0 && (
                  <optgroup label="People">
                    {people.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {accounts.length > 0 && (
                  <optgroup label="Accounts">
                    {accounts.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
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
                <Link href="/admin/staff/activity" className={buttonVariants({ variant: "ghost" })}>
                  Reset
                </Link>
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
                    <th className="py-2 pr-3 font-medium">Where</th>
                    <th className="py-2 pr-3 font-medium">What</th>
                    <th className="py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((a) => {
                    const person = isPersonEvent(a.event);
                    const who = a.employeeName ?? a.actorName;
                    const detail = [eventDetail(a.event, a.payload), a.ref].filter(Boolean).join(" · ");
                    return (
                      <tr
                        key={a.key}
                        className={a.level === "error" ? "bg-red-50/60 dark:bg-red-950/20" : a.level === "warn" ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}
                      >
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-muted-foreground">{timeFmt.format(new Date(a.at))}</td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {who ? (
                            <span className={person ? "font-medium" : ""}>
                              {who}
                              {a.employeeName && a.actorName && (
                                <span className="ml-1 text-xs font-normal text-muted-foreground">on {a.actorName}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{a.source === "web" ? "Web" : "Tablet"}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{a.source === "web" ? "Web" : (a.kioskSlug ?? "Tablet")}</td>
                        <td className="py-2 pr-3">{eventLabel(a.event, a.changed, a.payload)}</td>
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
              <span className="text-xs text-muted-foreground">Showing {rows.length.toLocaleString("en-US")}</span>
              {loadMoreError && <span className="text-xs text-destructive">Could not load more. Try again.</span>}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
