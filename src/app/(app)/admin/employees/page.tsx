import { BUSINESS_TZ, getLocalDateRange, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import { isEventGroup } from "@/lib/kiosk/events";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { ActivityFeed } from "./activity-feed";
import {
  rpcArgs,
  toRow,
  type ActivityFilter,
  type ActivityRow,
  type KioskOption,
  type PersonOption,
} from "./activity-shared";
import { EmployeesView } from "./employees-view";

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The people who use the kiosk tablets (one pool shared by every business, each
 * with a 4-digit PIN) and what they, and the web logins, did. The activity is read
 * through the `activity_feed` RPC (tablet events and the web audit log as one
 * stream), which applies the filters from the URL and pages by keyset, so a busy
 * day never comes into memory; the client component keeps it live.
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
  const person = /^[es]:/.test(sp.person ?? "") && UUID_RE.test((sp.person ?? "").slice(2)) ? (sp.person as string) : "";
  const filter: ActivityFilter = {
    day,
    isToday: day === today,
    startUtc: range.startUtc,
    endUtcExclusive: range.endUtcExclusive,
    source: sp.source === "tablet" || sp.source === "web" ? sp.source : "",
    person,
    kiosk: (sp.kiosk ?? "").slice(0, 64),
    group,
    // The housekeeping group is nothing but debug rows, so asking for it means showing them.
    includeDebug: group === "tablet",
  };

  const [empRes, staffRes, kioskRes, rowsRes] = await Promise.all([
    supabase
      .from("kiosk_employees")
      .select("id, name, is_active, last_seen_at, last_seen_kiosk")
      .order("name"),
    supabase.from("staff").select("id, full_name").eq("is_active", true).order("full_name"),
    supabase.from("kiosks").select("id, slug, name").order("slug"),
    supabase.rpc("activity_feed", { ...rpcArgs(filter), p_limit: PAGE_SIZE }),
  ]);

  for (const [label, r] of [["employees", empRes], ["staff", staffRes], ["kiosks", kioskRes], ["activity", rowsRes]] as const) {
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
  const accounts: PersonOption[] = (staffRes.data ?? []).map((s) => ({ id: s.id, name: s.full_name }));
  const kiosks: KioskOption[] = (kioskRes.data ?? [])
    .filter((k) => Boolean(k.slug))
    .map((k) => ({ id: k.id, slug: k.slug ?? "", name: k.name }));
  const rows: ActivityRow[] = (rowsRes.data ?? []).map(toRow);

  return (
    <div className="space-y-8">
      <EmployeesView employees={employees} loadError={Boolean(empRes.error)} />
      <ActivityFeed
        rows={rows}
        pageSize={PAGE_SIZE}
        filter={filter}
        employees={people}
        accounts={accounts}
        kiosks={kiosks}
        loadError={Boolean(rowsRes.error)}
      />
    </div>
  );
}
