import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { nyDateISO, nyLocalToUtcIso, shiftDayISO } from "@/lib/dashboard/queries";
import { parseLocalYmd } from "@/lib/dates";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { defaultRange } from "../hours-range";
import { HoursView, type PersonTotal, type ShiftRow } from "../hours-view";

/**
 * Hours: what the people who type a PIN worked, from the tablets' time clock.
 *
 * Owner only, and the RLS policy on time_clock_shifts says the same, so a
 * manager who guesses the URL gets the People tab, not a redirect loop and not
 * somebody's hours.
 *
 * The totals come from the time_clock_hours RPC (summed in Postgres, one row
 * per person) rather than from the shift rows, which are read for the list
 * itself. Anyone on the clock right now is fetched separately and ignores the
 * range: "who is working" is a question about now, whatever week is on screen.
 */

/** A wide range still reads one page. 500 rows is about two months of a busy week. */
const MAX_SHIFTS = 500;
/** Long enough to look through the list, short enough that a shared link dies. */
const PHOTO_URL_TTL_SECONDS = 60 * 60;

const SHIFT_COLUMNS =
  "id, employee_id, employee_name, clock_in_at, clock_out_at, clock_in_kiosk_slug, clock_out_kiosk_slug, photo_path, auto_closed_at, reviewed_at, edited_at";

type ShiftSelect = {
  id: string;
  employee_id: string | null;
  employee_name: string;
  clock_in_at: string;
  clock_out_at: string | null;
  clock_in_kiosk_slug: string | null;
  clock_out_kiosk_slug: string | null;
  photo_path: string | null;
  auto_closed_at: string | null;
  reviewed_at: string | null;
  edited_at: string | null;
};

function toRow(s: ShiftSelect, photos: Map<string, string>): ShiftRow {
  return {
    id: s.id,
    employeeId: s.employee_id,
    name: s.employee_name,
    inAt: s.clock_in_at,
    outAt: s.clock_out_at,
    inKiosk: s.clock_in_kiosk_slug,
    outKiosk: s.clock_out_kiosk_slug,
    photoUrl: s.photo_path ? (photos.get(s.photo_path) ?? null) : null,
    autoClosed: Boolean(s.auto_closed_at),
    reviewed: Boolean(s.reviewed_at),
    edited: Boolean(s.edited_at),
  };
}

export default async function HoursPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/staff/hours");
  if (staff.role !== "owner") redirect("/admin/staff/people");

  const sp = await searchParams;
  const today = nyDateISO();
  const thisWeek = defaultRange(today);
  const from = parseLocalYmd(sp.from) ?? thisWeek.from;
  const to = parseLocalYmd(sp.to) ?? thisWeek.to;
  // Business-time day bounds, end exclusive: the same window the RPC sums over.
  const startIso = nyLocalToUtcIso(from, "00:00");
  const endIso = nyLocalToUtcIso(shiftDayISO(to, 1), "00:00");

  const supabase = await getSupabaseServerClient();
  const [totalsRes, shiftsRes, openRes, reviewRes] = await Promise.all([
    supabase.rpc("time_clock_hours", { p_start: startIso, p_end: endIso }),
    supabase
      .from("time_clock_shifts")
      .select(SHIFT_COLUMNS)
      .gte("clock_in_at", startIso)
      .lt("clock_in_at", endIso)
      .order("clock_in_at", { ascending: false })
      .limit(MAX_SHIFTS)
      .returns<ShiftSelect[]>(),
    supabase
      .from("time_clock_shifts")
      .select(SHIFT_COLUMNS)
      .is("clock_out_at", null)
      .order("clock_in_at", { ascending: true })
      .returns<ShiftSelect[]>(),
    // Shifts still waiting on the owner, whatever range is on screen: the
    // default view is today, and a clock out forgotten on Tuesday would
    // otherwise never be in front of anyone. The oldest one gives the banner
    // a range to jump to.
    supabase
      .from("time_clock_shifts")
      .select("clock_in_at", { count: "exact" })
      .not("auto_closed_at", "is", null)
      .is("reviewed_at", null)
      .order("clock_in_at", { ascending: true })
      .limit(1)
      .returns<{ clock_in_at: string }[]>(),
  ]);

  if (totalsRes.error) console.error("[hours] totals fetch error:", totalsRes.error);
  if (shiftsRes.error) console.error("[hours] shifts fetch error:", shiftsRes.error);
  if (openRes.error) console.error("[hours] open shifts fetch error:", openRes.error);

  const shiftRows = shiftsRes.data ?? [];
  const openRows = openRes.data ?? [];

  // The photos live in a private bucket, so each one needs a signed link. One
  // call for every photo on the page, and only the owner's session can get them.
  const paths = Array.from(
    new Set([...shiftRows, ...openRows].map((s) => s.photo_path).filter((p): p is string => Boolean(p))),
  );
  const photos = new Map<string, string>();
  if (paths.length > 0) {
    const { data, error } = await supabase.storage
      .from("time-clock-photos")
      .createSignedUrls(paths, PHOTO_URL_TTL_SECONDS);
    if (error) console.error("[hours] photo links error:", error);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) photos.set(item.path, item.signedUrl);
    }
  }

  const totals: PersonTotal[] = (totalsRes.data ?? []).map((t) => ({
    employeeId: t.employee_id,
    name: t.employee_name,
    shifts: Number(t.shifts ?? 0),
    days: Number(t.days ?? 0),
    minutes: Number(t.minutes ?? 0),
    open: Number(t.open_shifts ?? 0),
    needsReview: Number(t.needs_review ?? 0),
  }));

  const oldestFlagged = reviewRes.data?.[0]?.clock_in_at ?? null;

  return (
    <HoursView
      totals={totals}
      needsReview={{
        count: reviewRes.count ?? 0,
        from: oldestFlagged ? nyDateISO(new Date(oldestFlagged)) : null,
        to: today,
      }}
      shifts={shiftRows.map((s) => toRow(s, photos))}
      onTheClock={openRows.map((s) => toRow(s, photos))}
      filters={{ from, to }}
      truncated={shiftRows.length >= MAX_SHIFTS}
      loadError={Boolean(totalsRes.error || shiftsRes.error)}
    />
  );
}
