"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type UpdateTourState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  saved?: true;
};

type TimeslotInput = {
  start_time: string;
  duration_minutes: number;
  sort_order: number;
};

function parseTimeslots(
  formData: FormData,
  fieldErrors: Record<string, string>,
): TimeslotInput[] {
  const slots: TimeslotInput[] = [];
  for (let i = 0; i < 20; i++) {
    const start = String(formData.get(`slot_${i}_start`) ?? "").trim();
    const durRaw = String(formData.get(`slot_${i}_duration`) ?? "").trim();
    if (!start && !durRaw) continue;
    if (!start) {
      fieldErrors[`slot_${i}_start`] = "Start time required.";
      continue;
    }
    const dur = Number(durRaw);
    if (!Number.isFinite(dur) || dur <= 0) {
      fieldErrors[`slot_${i}_duration`] = "Duration must be a positive number of minutes.";
      continue;
    }
    const normalized = /^\d{2}:\d{2}$/.test(start) ? `${start}:00` : start;
    slots.push({
      start_time: normalized,
      duration_minutes: Math.round(dur),
      sort_order: (i + 1) * 10,
    });
  }
  const seen = new Set<string>();
  for (const s of slots) {
    if (seen.has(s.start_time)) {
      fieldErrors.slot_dup = `Two timeslots have the same start time (${s.start_time.slice(0, 5)}).`;
      break;
    }
    seen.add(s.start_time);
  }
  return slots;
}

export async function updateTourAction(
  id: string,
  _prev: UpdateTourState,
  formData: FormData,
): Promise<UpdateTourState> {
  const supabase = await getSupabaseServerClient();

  const name = String(formData.get("name") ?? "").trim();
  const capacityRaw = String(formData.get("capacity") ?? "").trim();
  const capacity = Number(capacityRaw);
  const is_active = formData.get("is_active") === "1";
  const instructions =
    String(formData.get("instructions") ?? "").trim() || null;
  const meeting_point_address =
    String(formData.get("meeting_point_address") ?? "").trim() || null;
  const latRaw = String(formData.get("meeting_point_lat") ?? "").trim();
  const lngRaw = String(formData.get("meeting_point_lng") ?? "").trim();
  const meeting_point_lat = latRaw ? Number(latRaw) : null;
  const meeting_point_lng = lngRaw ? Number(lngRaw) : null;
  const selectedBusinessIds = new Set(
    formData.getAll("business_ids").map((v) => String(v)).filter(Boolean),
  );

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (!capacityRaw || !Number.isFinite(capacity) || capacity <= 0) {
    fieldErrors.capacity = "Capacity must be a positive whole number.";
  }
  if (
    (meeting_point_lat !== null && !Number.isFinite(meeting_point_lat)) ||
    (meeting_point_lng !== null && !Number.isFinite(meeting_point_lng))
  ) {
    fieldErrors.meeting_point = "Meeting point coordinates are invalid.";
  }
  const slots = parseTimeslots(formData, fieldErrors);
  if (slots.length === 0) {
    fieldErrors.slot_0_start = "At least one timeslot is required.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const { error: updErr } = await supabase
    .from("tours")
    .update({
      name,
      capacity,
      is_active,
      instructions,
      meeting_point_address,
      meeting_point_lat,
      meeting_point_lng,
    })
    .eq("id", id);
  if (updErr) return { error: updErr.message };

  // Replace-all strategy for timeslots: delete current rows, then insert new
  // rows. Cheap and simple at this scale, and avoids tricky diffing.
  const { error: delErr } = await supabase
    .from("tour_timeslots")
    .delete()
    .eq("tour_id", id);
  if (delErr) return { error: `Could not refresh timeslots: ${delErr.message}` };

  if (slots.length > 0) {
    const rows = slots.map((s) => ({ tour_id: id, ...s }));
    const { error: insErr } = await supabase
      .from("tour_timeslots")
      .insert(rows);
    if (insErr) return { error: `Timeslots failed to save: ${insErr.message}` };
  }

  // Sync the business assignments. Preserve existing assignments (and their
  // per-business pax tier prices). Only insert newly checked and delete newly
  // unchecked. If a delete fails due to existing bookings, surface a friendly
  // error but the rest of the save is already persisted.
  const { data: existing, error: existingErr } = await supabase
    .from("business_tours")
    .select("id, business_id")
    .eq("tour_id", id);
  if (existingErr) {
    return { error: `Could not read business assignments: ${existingErr.message}` };
  }
  const existingByBusiness = new Map(
    (existing ?? []).map((r) => [r.business_id, r.id]),
  );
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const bid of selectedBusinessIds) {
    if (!existingByBusiness.has(bid)) toAdd.push(bid);
  }
  for (const [bid, btId] of existingByBusiness) {
    if (!selectedBusinessIds.has(bid)) toRemove.push(btId);
  }

  if (toAdd.length > 0) {
    const { data: newVariants, error: addErr } = await supabase
      .from("business_tours")
      .insert(toAdd.map((bid) => ({ tour_id: id, business_id: bid, name })))
      .select("id");
    if (addErr) {
      return { error: `Could not assign businesses: ${addErr.message}` };
    }
    // Seed default pax tiers so the variant is immediately bookable.
    const tierRows = (newVariants ?? []).flatMap((v) => [
      { business_tour_id: v.id, label: "adult",  description: "Ages 13+",  price_cents: 5000, sort_order: 10 },
      { business_tour_id: v.id, label: "child",  description: "Ages 4-12", price_cents: 2500, sort_order: 20 },
      { business_tour_id: v.id, label: "infant", description: "Under 4",   price_cents: 0,    sort_order: 30 },
    ]);
    if (tierRows.length > 0) {
      const { error: tierErr } = await supabase
        .from("tour_pax_tiers")
        .insert(tierRows);
      if (tierErr) {
        return {
          error: `Business assignments saved but default prices failed: ${tierErr.message}`,
        };
      }
    }
  }

  if (toRemove.length > 0) {
    const { error: delErr } = await supabase
      .from("business_tours")
      .delete()
      .in("id", toRemove);
    if (delErr) {
      if (delErr.code === "23503") {
        return {
          error:
            "One or more businesses still have bookings on this tour. Cancel or move those bookings before removing the business.",
        };
      }
      return { error: `Could not remove a business: ${delErr.message}` };
    }
  }

  revalidatePath("/admin/tours");
  revalidatePath(`/admin/tours/${id}`);
  revalidatePath("/admin");
  return { saved: true };
}

export type DeleteTourState = { error?: string };

export async function deleteTourAction(
  id: string,
): Promise<DeleteTourState> {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("tours").delete().eq("id", id);
  if (error) {
    if (error.code === "23503") {
      return {
        error:
          "This tour has business variants or bookings attached. Remove those first, then try again.",
      };
    }
    return { error: error.message };
  }
  revalidatePath("/admin/tours");
  revalidatePath("/admin");
  redirect("/admin/tours");
}
