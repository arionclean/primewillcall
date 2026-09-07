import { BUSINESS_TZ, getLocalDateRange, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import {
  EmployeesView,
  type ActivityRow,
  type EmployeeRow,
  type KioskOption,
} from "./employees-view";

/**
 * The people who use the kiosk tablets (one pool shared by every business, each
 * with a 4-digit PIN) and what they did. The activity comes from kiosk_events, one
 * row per thing a tablet or the server recorded, filtered here by day, person and
 * kiosk; RLS scopes those rows by business.
 */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ employee?: string; day?: string; kiosk?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  const { employee: employeeFilter, day: dayParam, kiosk: kioskFilter } = await searchParams;
  const day = parseLocalYmd(dayParam) ?? todayLocalIso(BUSINESS_TZ);
  const { startUtc, endUtcExclusive } = getLocalDateRange(day, BUSINESS_TZ);

  const [empRes, kioskRes] = await Promise.all([
    supabase
      .from("kiosk_employees")
      .select("id, name, is_active, last_seen_at, last_seen_kiosk")
      .order("name"),
    supabase.from("kiosks").select("id, slug, name").order("slug"),
  ]);

  let activityQuery = supabase
    .from("kiosk_events")
    .select("id, at, event, level, ref, payload, kiosk_slug, employee_id, employee_name, app_build")
    .gte("at", startUtc)
    .lt("at", endUtcExclusive)
    .order("at", { ascending: false })
    .limit(400);
  if (employeeFilter) activityQuery = activityQuery.eq("employee_id", employeeFilter);
  if (kioskFilter) activityQuery = activityQuery.eq("kiosk_slug", kioskFilter);
  const actRes = await activityQuery;

  for (const [label, r] of [["employees", empRes], ["kiosks", kioskRes], ["activity", actRes]] as const) {
    if (r.error) console.error(`[employees] ${label} fetch error:`, r.error);
  }

  const employees: EmployeeRow[] = (empRes.data ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    isActive: e.is_active,
    lastSeenAt: e.last_seen_at,
    lastSeenKiosk: e.last_seen_kiosk,
  }));
  const kiosks: KioskOption[] = (kioskRes.data ?? [])
    .filter((k) => Boolean(k.slug))
    .map((k) => ({ id: k.id, slug: k.slug ?? "", name: k.name }));
  const activity: ActivityRow[] = (actRes.data ?? []).map((a) => ({
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
    <EmployeesView
      employees={employees}
      kiosks={kiosks}
      activity={activity}
      filters={{ employee: employeeFilter ?? "", day, kiosk: kioskFilter ?? "" }}
      loadError={Boolean(empRes.error || actRes.error)}
    />
  );
}
