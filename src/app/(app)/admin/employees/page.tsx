import { BUSINESS_TZ, getLocalDateRange, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import { EVENT_GROUPS, isEventGroup } from "@/lib/kiosk/events";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { ActivityFeed, type ActivityFilter, type ActivityRow, type KioskOption, type PersonOption } from "./activity-feed";
import { EmployeesView } from "./employees-view";

const PAGE_SIZE = 100;

/**
 * The people who use the kiosk tablets (one pool shared by every business, each
 * with a 4-digit PIN) and what they did. The activity is read through the
 * `kiosk_activity` RPC, which applies the filters from the URL and pages by keyset,
 * so a busy day never comes into memory; the client component keeps it live.
 */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const supabase = await getSupabaseServerClient();
  const sp = await searchParams;

  const today = todayLocalIso(BUSINESS_TZ);
  const day = parseLocalYmd(sp.day) ?? today;
  const range = getLocalDateRange(day, BUSINESS_TZ);
  const group = isEventGroup(sp.group) ? sp.group : "";
  const filter: ActivityFilter = {
    day,
    isToday: day === today,
    startUtc: range.startUtc,
    endUtcExclusive: range.endUtcExclusive,
    employee: /^[0-9a-f-]{36}$/i.test(sp.employee ?? "") ? (sp.employee as string) : "",
    kiosk: (sp.kiosk ?? "").slice(0, 64),
    group,
    // The housekeeping group is nothing but debug rows, so asking for it means showing them.
    includeDebug: group === "tablet",
  };
  const args = {
    p_from: filter.startUtc,
    p_to: filter.endUtcExclusive,
    p_employee: filter.employee || undefined,
    p_kiosk: filter.kiosk || undefined,
    p_events: filter.group ? [...EVENT_GROUPS[filter.group].events] : undefined,
    p_include_debug: filter.includeDebug,
  };

  const [empRes, kioskRes, rowsRes, countRes] = await Promise.all([
    supabase
      .from("kiosk_employees")
      .select("id, name, is_active, last_seen_at, last_seen_kiosk")
      .order("name"),
    supabase.from("kiosks").select("id, slug, name").order("slug"),
    supabase.rpc("kiosk_activity", { ...args, p_limit: PAGE_SIZE }),
    supabase.rpc("kiosk_activity_count", args),
  ]);

  for (const [label, r] of [["employees", empRes], ["kiosks", kioskRes], ["activity", rowsRes], ["count", countRes]] as const) {
    if (r.error) console.error(`[employees] ${label} fetch error:`, r.error);
  }

  const employees = (empRes.data ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    isActive: e.is_active,
    lastSeenAt: e.last_seen_at,
    lastSeenKiosk: e.last_seen_kiosk,
  }));
  const people: PersonOption[] = employees.map((e) => ({ id: e.id, name: e.name }));
  const kiosks: KioskOption[] = (kioskRes.data ?? [])
    .filter((k) => Boolean(k.slug))
    .map((k) => ({ id: k.id, slug: k.slug ?? "", name: k.name }));
  const rows: ActivityRow[] = (rowsRes.data ?? []).map((a) => ({
    id: a.id,
    at: a.at,
    event: a.event,
    level: a.level,
    ref: a.ref,
    payload: (a.payload as Record<string, unknown> | null) ?? null,
    kioskSlug: a.kiosk_slug,
    employeeId: a.employee_id,
    employeeName: a.employee_name,
    appBuild: a.app_build,
  }));

  return (
    <div className="space-y-8">
      <EmployeesView employees={employees} loadError={Boolean(empRes.error)} />
      <ActivityFeed
        rows={rows}
        total={Number(countRes.data ?? rows.length)}
        pageSize={PAGE_SIZE}
        filter={filter}
        employees={people}
        kiosks={kiosks}
        loadError={Boolean(rowsRes.error)}
      />
    </div>
  );
}
