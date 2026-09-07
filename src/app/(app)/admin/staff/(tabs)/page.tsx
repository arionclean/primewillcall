import { getCurrentStaff } from "@/lib/auth";
import { BUSINESS_TZ, getLocalDateRange, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import { isEventGroup } from "@/lib/kiosk/events";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { ActivityFeed } from "./activity-feed";
import {
  personValue,
  rpcArgs,
  toRow,
  type ActivityFilter,
  type ActivityRow,
  type KioskOption,
  type PersonOption,
} from "./activity-shared";
import { PeopleView, type PersonRow } from "./people-view";

const PAGE_SIZE = 100;

/**
 * People: everyone who works here, as one card each, whether they have a PIN
 * (a kiosk_employees row), a website login (a staff row with a managing role),
 * or both (linked by kiosk_employees.staff_id). Shared desk logins are not
 * people; they live on the Accounts tab. Below the people, the activity of
 * tablets and web as one stream, read through the `activity_feed` RPC (filters
 * from the URL, keyset paging); the client component keeps it live.
 */
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { staff: me } = await getCurrentStaff();
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
    source: sp.source === "tablet" || sp.source === "web" ? sp.source : "",
    person: (sp.person ?? "").slice(0, 80),
    kiosk: (sp.kiosk ?? "").slice(0, 64),
    group,
    // The housekeeping group is nothing but debug rows, so asking for it means showing them.
    includeDebug: group === "tablet",
  };

  const [staffRes, empRes, kioskRes, rowsRes] = await Promise.all([
    supabase
      .from("staff")
      .select("id, full_name, email, role, is_active, business:businesses!staff_business_id_fkey(name)")
      .in("role", ["owner", "business_manager"])
      .order("full_name"),
    supabase
      .from("kiosk_employees")
      .select("id, name, staff_id, is_active, last_seen_at, last_seen_kiosk")
      .order("name"),
    supabase.from("kiosks").select("id, slug, name").order("slug"),
    supabase.rpc("activity_feed", { ...rpcArgs(filter), p_limit: PAGE_SIZE }),
  ]);

  for (const [label, r] of [["staff", staffRes], ["employees", empRes], ["kiosks", kioskRes], ["activity", rowsRes]] as const) {
    if (r.error) console.error(`[people] ${label} fetch error:`, r.error);
  }

  // One card per person: a login with its PIN (if any), then the PIN-only people.
  const logins = staffRes.data ?? [];
  const employees = empRes.data ?? [];
  const loginIds = new Set(logins.map((s) => s.id));
  const byStaff = new Map(employees.filter((e) => e.staff_id).map((e) => [e.staff_id as string, e]));
  const people: PersonRow[] = [
    ...logins.map((s) => {
      const e = byStaff.get(s.id);
      return {
        name: s.full_name,
        employeeId: e?.id ?? null,
        staffId: s.id,
        email: s.email,
        role: s.role as "owner" | "business_manager",
        businessName: s.business?.name ?? null,
        isActive: s.is_active,
        lastSeenAt: e?.last_seen_at ?? null,
        lastSeenKiosk: e?.last_seen_kiosk ?? null,
      };
    }),
    ...employees
      .filter((e) => !e.staff_id || !loginIds.has(e.staff_id))
      .map((e) => ({
        name: e.name,
        employeeId: e.id,
        staffId: null,
        email: null,
        role: null,
        businessName: null,
        isActive: e.is_active,
        lastSeenAt: e.last_seen_at,
        lastSeenKiosk: e.last_seen_kiosk,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const personOptions: PersonOption[] = people.map((p) => ({
    value: personValue(p.employeeId, p.staffId),
    name: p.name,
  }));
  const kiosks: KioskOption[] = (kioskRes.data ?? [])
    .filter((k) => Boolean(k.slug))
    .map((k) => ({ id: k.id, slug: k.slug ?? "", name: k.name }));
  const rows: ActivityRow[] = (rowsRes.data ?? []).map(toRow);

  return (
    <div className="space-y-8">
      <PeopleView people={people} isOwner={me?.role === "owner"} loadError={Boolean(staffRes.error || empRes.error)} />
      <ActivityFeed
        rows={rows}
        pageSize={PAGE_SIZE}
        filter={filter}
        people={personOptions}
        kiosks={kiosks}
        loadError={Boolean(rowsRes.error)}
      />
    </div>
  );
}
