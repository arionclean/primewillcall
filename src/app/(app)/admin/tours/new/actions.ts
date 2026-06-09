"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type CreateTourState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
};

type TimeslotInput = {
  start_time: string; // "HH:MM" or "HH:MM:SS"
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
    // Normalize HH:MM to HH:MM:00 so Postgres time accepts it.
    const normalized = /^\d{2}:\d{2}$/.test(start) ? `${start}:00` : start;
    slots.push({
      start_time: normalized,
      duration_minutes: Math.round(dur),
      sort_order: (i + 1) * 10,
    });
  }
  // Catch duplicate start_times client-side so we surface a friendlier error.
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

export async function createTourAction(
  _prev: CreateTourState,
  formData: FormData,
): Promise<CreateTourState> {
  const supabase = await getSupabaseServerClient();

  const name = String(formData.get("name") ?? "").trim();
  const capacityRaw = String(formData.get("capacity") ?? "").trim();
  const capacity = Number(capacityRaw);
  const kind = "tour"; // master-level taxonomy; we keep the column for future segmentation
  const instructions =
    String(formData.get("instructions") ?? "").trim() || null;
  const meeting_point_address =
    String(formData.get("meeting_point_address") ?? "").trim() || null;
  const latRaw = String(formData.get("meeting_point_lat") ?? "").trim();
  const lngRaw = String(formData.get("meeting_point_lng") ?? "").trim();
  const meeting_point_lat = latRaw ? Number(latRaw) : null;
  const meeting_point_lng = lngRaw ? Number(lngRaw) : null;
  const business_ids = formData
    .getAll("business_ids")
    .map((v) => String(v))
    .filter(Boolean);

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
    fieldErrors.slot_0_start = "Add at least one timeslot.";
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const { data: tour, error: tourErr } = await supabase
    .from("tours")
    .insert({
      name,
      kind,
      capacity,
      instructions,
      meeting_point_address,
      meeting_point_lat,
      meeting_point_lng,
    })
    .select("id")
    .single();

  if (tourErr) return { error: tourErr.message };

  if (slots.length > 0) {
    const rows = slots.map((s) => ({ tour_id: tour.id, ...s }));
    const { error: slotsErr } = await supabase
      .from("tour_timeslots")
      .insert(rows);
    if (slotsErr) {
      return {
        error: `Tour was created but timeslots failed to save: ${slotsErr.message}`,
      };
    }
  }

  // Auto-create a variant for each selected business. We seed default pax
  // tiers (adult $50, child $25, infant $0) so the variant is bookable
  // immediately; the business can change prices via the variants list later.
  if (business_ids.length > 0) {
    const variantRows = business_ids.map((bid) => ({
      tour_id: tour.id,
      business_id: bid,
      name,
    }));
    const { data: variants, error: variantsErr } = await supabase
      .from("business_tours")
      .insert(variantRows)
      .select("id");
    if (variantsErr) {
      return {
        error: `Tour saved but variants failed to create: ${variantsErr.message}`,
      };
    }
    const tierRows = (variants ?? []).flatMap((v) => [
      { business_tour_id: v.id, label: "adult",  description: "Ages 13+",  price_cents: 5000, sort_order: 10 },
      { business_tour_id: v.id, label: "child",  description: "Ages 4-12", price_cents: 2500, sort_order: 20 },
      { business_tour_id: v.id, label: "infant", description: "Under 4",   price_cents: 0,    sort_order: 30 },
    ]);
    if (tierRows.length > 0) {
      const { error: tiersErr } = await supabase
        .from("tour_pax_tiers")
        .insert(tierRows);
      if (tiersErr) {
        return {
          error: `Variants created but default pax tiers failed: ${tiersErr.message}`,
        };
      }
    }
  }

  revalidatePath("/admin/tours");
  revalidatePath("/admin");
  redirect("/admin/tours");
}
