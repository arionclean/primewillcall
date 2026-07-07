import { NextResponse } from "next/server";

import { timeLabel } from "@/lib/dates";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Public timeslot lookup for the /gp page. Returns the active timeslots for the
 * matched product's master tour on a given date (the Supabase-native replacement
 * for Xano's manage_slots). Past times are hidden when the date is today (NY),
 * and times closed for that date on the availability board are excluded.
 */

const BUSINESS_TZ = "America/New_York";

/** Today's date (YYYY-MM-DD) and current HH:MM in New York. */
function nyNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return { date, minutes: hour * 60 + Number(get("minute")) };
}

export async function GET(req: Request) {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ slots: [], error: "not_configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const businessTourId = url.searchParams.get("business_tour_id")?.trim() ?? "";
  const date = url.searchParams.get("date")?.trim() ?? "";
  if (!businessTourId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ slots: [], error: "bad_request" }, { status: 400 });
  }

  const { data: bt } = await admin
    .from("business_tours")
    .select("tour_id, is_active, groupon_fee_cents")
    .eq("id", businessTourId)
    .maybeSingle();
  if (!bt || !bt.is_active || bt.groupon_fee_cents === null) {
    return NextResponse.json({ slots: [] }, { status: 200 });
  }

  const [{ data: slots, error }, { data: closures }] = await Promise.all([
    admin
      .from("tour_timeslots")
      .select("start_time, duration_minutes")
      .eq("tour_id", bt.tour_id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    admin
      .from("tour_slot_closures")
      .select("start_time")
      .eq("tour_id", bt.tour_id)
      .eq("closed_on", date),
  ]);
  if (error) {
    return NextResponse.json({ slots: [], error: error.message }, { status: 500 });
  }
  const closed = new Set((closures ?? []).map((c) => c.start_time.slice(0, 5)));

  const now = nyNow();
  const isToday = date === now.date;

  const out = (slots ?? [])
    .map((s) => {
      const hhmm = s.start_time.slice(0, 5); // "10:30:00" -> "10:30"
      const [h, m] = hhmm.split(":").map(Number);
      return {
        value: hhmm,
        label: timeLabel(s.start_time),
        durationMinutes: s.duration_minutes,
        minutes: h * 60 + m,
      };
    })
    .filter((s) => !closed.has(s.value))
    .filter((s) => !isToday || s.minutes > now.minutes)
    .map(({ value, label, durationMinutes }) => ({ value, label, durationMinutes }));

  return NextResponse.json({ slots: out });
}
