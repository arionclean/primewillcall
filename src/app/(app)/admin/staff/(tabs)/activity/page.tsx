import { BUSINESS_TZ, getLocalDateRange, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import { isEventGroup } from "@/lib/kiosk/events";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { ActivityFeed } from "../activity-feed";
import { rpcArgs, toRow, type ActivityFilter, type ActivityRow, type KioskOption } from "../activity-shared";
import { loadPersonOptions } from "../people";

const PAGE_SIZE = 100;

/**
 * Activity: what the tablets and the web app recorded, one stream, read through
 * the `activity_feed` RPC (filters from the URL, keyset paging) so a busy day
 * never comes into memory; the client component keeps it live.
 */
export default async function ActivityPage({
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
    source: sp.source === "tablet" || sp.source === "web" ? sp.source : "",
    person: (sp.person ?? "").slice(0, 80),
    kiosk: (sp.kiosk ?? "").slice(0, 64),
    group,
    // The housekeeping group is nothing but debug rows, so asking for it means showing them.
    includeDebug: group === "tablet",
  };

  const [options, kioskRes, rowsRes] = await Promise.all([
    loadPersonOptions(supabase),
    supabase.from("kiosks").select("id, slug, name").order("slug"),
    supabase.rpc("activity_feed", { ...rpcArgs(filter), p_limit: PAGE_SIZE }),
  ]);
  if (kioskRes.error) console.error("[activity] kiosks fetch error:", kioskRes.error);
  if (rowsRes.error) console.error("[activity] fetch error:", rowsRes.error);

  const kiosks: KioskOption[] = (kioskRes.data ?? [])
    .filter((k) => Boolean(k.slug))
    .map((k) => ({ id: k.id, slug: k.slug ?? "", name: k.name }));
  const rows: ActivityRow[] = (rowsRes.data ?? []).map(toRow);

  return (
    <ActivityFeed
      rows={rows}
      pageSize={PAGE_SIZE}
      filter={filter}
      people={options.people}
      accounts={options.accounts}
      kiosks={kiosks}
      loadError={Boolean(rowsRes.error)}
    />
  );
}
