import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { parseLocalYmd, timeLabel, todayLocalIso } from "@/lib/dates";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { AvailabilityBoard, type TourDay } from "./board";

/**
 * Availability board: open or close booking times per day. The recurring
 * schedule lives on the master tour (owner edits it under Tours); this page
 * handles the day-to-day exceptions. Closing a time removes it from the public
 * Groupon page (/gp) for that date immediately. Existing bookings are not
 * affected.
 *
 * Owner sees every active tour. A business manager sees the tours assigned to
 * their business (under the business's own tour names). Closures apply to the
 * departure itself, so they affect every business sharing the tour.
 */

type TimeslotRow = {
  start_time: string;
  duration_minutes: number;
  sort_order: number;
  is_active: boolean;
};

function buildTourDay(
  tourId: string,
  name: string,
  timeslots: TimeslotRow[],
  closedKeys: Set<string>,
): TourDay {
  const slots = timeslots
    .filter((s) => s.is_active)
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.start_time.localeCompare(b.start_time),
    )
    .map((s) => {
      const startTime = s.start_time.slice(0, 5); // "10:30:00" -> "10:30"
      return {
        startTime,
        label: timeLabel(s.start_time),
        closed: closedKeys.has(`${tourId}|${startTime}`),
      };
    });
  return { tourId, name, slots };
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date: rawDate } = await searchParams;
  const today = todayLocalIso();
  const date = parseLocalYmd(rawDate ?? null) ?? today;
  if (date < today) redirect("/availability");

  const { staff } = await getCurrentStaff();
  if (!staff) redirect("/dashboard"); // layout already gates; this narrows the type

  const supabase = await getSupabaseServerClient();

  const closuresPromise = supabase
    .from("tour_slot_closures")
    .select("tour_id, start_time")
    .eq("closed_on", date);

  let tours: TourDay[] = [];

  if (staff.role === "owner") {
    const [{ data: rows }, { data: closures }] = await Promise.all([
      supabase
        .from("tours")
        .select(
          "id, name, tour_timeslots(start_time, duration_minutes, sort_order, is_active)",
        )
        .eq("is_active", true)
        .order("name"),
      closuresPromise,
    ]);
    const closedKeys = new Set(
      (closures ?? []).map((c) => `${c.tour_id}|${c.start_time.slice(0, 5)}`),
    );
    tours = (rows ?? []).map((t) =>
      buildTourDay(t.id, t.name, t.tour_timeslots, closedKeys),
    );
  } else {
    // Business manager: RLS scopes business_tours to their business. Show the
    // business's own tour names, never the master catalog names.
    const [{ data: rows }, { data: closures }] = await Promise.all([
      supabase
        .from("business_tours")
        .select(
          "name, tour_id, tours(id, is_active, tour_timeslots(start_time, duration_minutes, sort_order, is_active))",
        )
        .eq("is_active", true)
        .order("name"),
      closuresPromise,
    ]);
    const closedKeys = new Set(
      (closures ?? []).map((c) => `${c.tour_id}|${c.start_time.slice(0, 5)}`),
    );
    tours = (rows ?? [])
      .filter((r) => r.tours?.is_active)
      .map((r) =>
        buildTourDay(r.tour_id, r.name, r.tours?.tour_timeslots ?? [], closedKeys),
      );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Availability</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open or close booking times for a specific day. Closed times stop
          showing on the public Groupon page right away. Bookings that already
          exist are not changed.
        </p>
      </header>

      <AvailabilityBoard date={date} today={today} tours={tours} />
    </div>
  );
}
