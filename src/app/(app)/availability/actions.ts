"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { parseLocalYmd } from "@/lib/dates";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type AvailabilityActionState = { error?: string };

const NO_PERMISSION =
  "You do not have permission to change this tour's availability.";

/**
 * Shared auth for the availability actions: signed-in, active, owner or
 * business manager. Managers must additionally belong to a business that is
 * assigned to the tour (RLS enforces the same rule as the backstop).
 */
async function authorize(tourId: string): Promise<
  | { error: string }
  | { staffId: string; supabase: Awaited<ReturnType<typeof getSupabaseServerClient>> }
> {
  const { staff } = await getCurrentStaff();
  if (
    !staff ||
    !staff.is_active ||
    (staff.role !== "owner" && staff.role !== "business_manager")
  ) {
    return { error: NO_PERMISSION };
  }

  const supabase = await getSupabaseServerClient();

  if (staff.role === "business_manager") {
    if (!staff.business_id) return { error: NO_PERMISSION };
    const { data: assigned } = await supabase
      .from("business_tours")
      .select("id")
      .eq("tour_id", tourId)
      .eq("business_id", staff.business_id)
      .maybeSingle();
    if (!assigned) return { error: NO_PERMISSION };
  }

  return { staffId: staff.id, supabase };
}

function friendly(error: { code?: string; message: string }): string {
  return error.code === "42501" ? NO_PERMISSION : error.message;
}

/** Close (insert) or reopen (delete) a single time on a single date. */
export async function setSlotAvailabilityAction(input: {
  tourId: string;
  date: string;
  startTime: string; // "HH:MM"
  closed: boolean;
}): Promise<AvailabilityActionState> {
  const auth = await authorize(input.tourId);
  if ("error" in auth) return { error: auth.error };

  const date = parseLocalYmd(input.date);
  if (!date || !/^\d{2}:\d{2}$/.test(input.startTime)) {
    return { error: "Invalid date or time." };
  }
  const startTime = `${input.startTime}:00`;

  if (input.closed) {
    const { error } = await auth.supabase.from("tour_slot_closures").upsert(
      {
        tour_id: input.tourId,
        closed_on: date,
        start_time: startTime,
        created_by: auth.staffId,
      },
      { onConflict: "tour_id,closed_on,start_time", ignoreDuplicates: true },
    );
    if (error) return { error: friendly(error) };
  } else {
    const { error } = await auth.supabase
      .from("tour_slot_closures")
      .delete()
      .eq("tour_id", input.tourId)
      .eq("closed_on", date)
      .eq("start_time", startTime);
    if (error) return { error: friendly(error) };
  }

  revalidatePath("/availability");
  return {};
}

/** Close or reopen every time a tour runs on a single date. */
export async function setDayAvailabilityAction(input: {
  tourId: string;
  date: string;
  closed: boolean;
}): Promise<AvailabilityActionState> {
  const auth = await authorize(input.tourId);
  if ("error" in auth) return { error: auth.error };

  const date = parseLocalYmd(input.date);
  if (!date) return { error: "Invalid date." };

  if (input.closed) {
    const { data: slots, error: slotsErr } = await auth.supabase
      .from("tour_timeslots")
      .select("start_time")
      .eq("tour_id", input.tourId)
      .eq("is_active", true);
    if (slotsErr) return { error: friendly(slotsErr) };

    const rows = (slots ?? []).map((s) => ({
      tour_id: input.tourId,
      closed_on: date,
      start_time: s.start_time,
      created_by: auth.staffId,
    }));
    if (rows.length > 0) {
      const { error } = await auth.supabase
        .from("tour_slot_closures")
        .upsert(rows, {
          onConflict: "tour_id,closed_on,start_time",
          ignoreDuplicates: true,
        });
      if (error) return { error: friendly(error) };
    }
  } else {
    const { error } = await auth.supabase
      .from("tour_slot_closures")
      .delete()
      .eq("tour_id", input.tourId)
      .eq("closed_on", date);
    if (error) return { error: friendly(error) };
  }

  revalidatePath("/availability");
  return {};
}
