import { EVENT_GROUPS, type EventGroup } from "@/lib/kiosk/events";

/**
 * Shapes and helpers the Employees page and its live feed share. No "use client"
 * here on purpose: the server component calls `rpcArgs` and `toRow` for the first
 * page, the client component for the pages after it and the live rows.
 */

export type ActivitySource = "tablet" | "web";

export type ActivityRow = {
  key: string;
  source: ActivitySource;
  at: string;
  event: string;
  level: string;
  ref: string | null;
  payload: Record<string, unknown> | null;
  kioskSlug: string | null;
  employeeId: string | null;
  employeeName: string | null;
  actorStaffId: string | null;
  actorName: string | null;
  changed: string[];
};

/** The filter as the page resolved it from the URL: what the database was asked. */
export type ActivityFilter = {
  day: string; // local YYYY-MM-DD
  isToday: boolean;
  startUtc: string;
  endUtcExclusive: string;
  source: ActivitySource | "";
  /** "e:<employee id>" or "s:<staff id>". */
  person: string;
  kiosk: string;
  group: EventGroup | "";
  /** Tablet housekeeping (debug rows) shows only when that group is picked. */
  includeDebug: boolean;
};

export type PersonOption = { id: string; name: string };
export type KioskOption = { id: string; slug: string; name: string };

export function personParts(person: string): { employee?: string; staff?: string } {
  if (person.startsWith("e:")) return { employee: person.slice(2) };
  if (person.startsWith("s:")) return { staff: person.slice(2) };
  return {};
}

export function rpcArgs(f: ActivityFilter) {
  const who = personParts(f.person);
  return {
    p_from: f.startUtc,
    p_to: f.endUtcExclusive,
    p_source: f.source || undefined,
    p_employee: who.employee,
    p_staff: who.staff,
    p_kiosk: f.kiosk || undefined,
    p_events: f.group ? [...EVENT_GROUPS[f.group].events] : undefined,
    p_include_debug: f.includeDebug,
  };
}

export type FeedRpcRow = {
  key: string;
  source: string;
  at: string;
  event: string;
  level: string;
  ref: string | null;
  payload: unknown;
  kiosk_slug: string | null;
  employee_id: string | null;
  employee_name: string | null;
  actor_staff_id: string | null;
  actor_name: string | null;
  changed: string[] | null;
};

export function toRow(r: FeedRpcRow): ActivityRow {
  return {
    key: r.key,
    source: r.source === "web" ? "web" : "tablet",
    at: r.at,
    event: r.event,
    level: r.level,
    ref: r.ref,
    payload: (r.payload as Record<string, unknown> | null) ?? null,
    kioskSlug: r.kiosk_slug,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    actorStaffId: r.actor_staff_id,
    actorName: r.actor_name,
    changed: r.changed ?? [],
  };
}
