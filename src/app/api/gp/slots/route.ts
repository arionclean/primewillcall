import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Public timeslot lookup for the /gp page. Returns the active timeslots for the
 * matched product's master tour on a given date (the Supabase-native replacement
 * for Xano's manage_slots). Past times are hidden when the date is today (NY).
 */

const BUSINESS_TZ = "America/New_York";

/** "10:30:00" -> "10:30 AM". */
function toLabel(startTime: string): string {
  const [hStr, mStr] = startTime.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return startTime;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

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

  const { data: slots, error } = await admin
    .from("tour_timeslots")
    .select("start_time, duration_minutes")
    .eq("tour_id", bt.tour_id)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    return NextResponse.json({ slots: [], error: error.message }, { status: 500 });
  }

  const now = nyNow();
  const isToday = date === now.date;

  const out = (slots ?? [])
    .map((s) => {
      const hhmm = s.start_time.slice(0, 5); // "10:30:00" -> "10:30"
      const [h, m] = hhmm.split(":").map(Number);
      return {
        value: hhmm,
        label: toLabel(s.start_time),
        durationMinutes: s.duration_minutes,
        minutes: h * 60 + m,
      };
    })
    .filter((s) => !isToday || s.minutes > now.minutes)
    .map(({ value, label, durationMinutes }) => ({ value, label, durationMinutes }));

  return NextResponse.json({ slots: out });
}
