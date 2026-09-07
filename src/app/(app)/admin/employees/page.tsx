import { getCurrentStaff } from "@/lib/auth";
import { BUSINESS_TZ, getLocalDateRange, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import {
  EmployeesView,
  type ActivityRow,
  type BusinessOption,
  type EmployeeRow,
  type KioskOption,
} from "./employees-view";

/**
 * The people who use the kiosk tablets (each with a 4-digit PIN) and what they
 * did. Reads are RLS-scoped: an owner sees every business, a manager their own.
 * The activity comes from kiosk_events, one row per thing a tablet or the server
 * recorded, filtered here by day, person and kiosk.
 */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ employee?: string; day?: string; kiosk?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  const supabase = await getSupabaseServerClient();
  const { employee: employeeFilter, day: dayParam, kiosk: kioskFilter } = await searchParams;
  const day = parseLocalYmd(dayParam) ?? todayLocalIso(BUSINESS_TZ);
  const { startUtc, endUtcExclusive } = getLocalDateRange(day, BUSINESS_TZ);

  const [bizRes, empRes, kioskRes] = await Promise.all([
    supabase.from("businesses").select("id, name").order("name"),
    supabase
      .from("kiosk_employees")
      .select("id, name, business_id, is_active, last_seen_at, last_seen_kiosk, created_at")
      .order("name"),
    supabase.from("kiosks").select("id, slug, name, business_id, pin_required").order("slug"),
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

  for (const [label, r] of [["businesses", bizRes], ["employees", empRes], ["kiosks", kioskRes], ["activity", actRes]] as const) {
    if (r.error) console.error(`[employees] ${label} fetch error:`, r.error);
  }

  const businesses: BusinessOption[] = (bizRes.data ?? []).map((b) => ({ id: b.id, name: b.name }));
  const employees: EmployeeRow[] = (empRes.data ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    businessId: e.business_id,
    isActive: e.is_active,
    lastSeenAt: e.last_seen_at,
    lastSeenKiosk: e.last_seen_kiosk,
  }));
  const kiosks: KioskOption[] = (kioskRes.data ?? [])
    .filter((k) => Boolean(k.slug))
    .map((k) => ({
      id: k.id,
      slug: k.slug ?? "",
      name: k.name,
      businessId: k.business_id,
      pinRequired: k.pin_required,
    }));
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
      isOwner={staff?.role === "owner"}
      managerBusinessId={staff?.role === "business_manager" ? staff.business_id : null}
      businesses={businesses}
      employees={employees}
      kiosks={kiosks}
      activity={activity}
      filters={{ employee: employeeFilter ?? "", day, kiosk: kioskFilter ?? "" }}
      loadError={Boolean(empRes.error || actRes.error)}
    />
  );
}
