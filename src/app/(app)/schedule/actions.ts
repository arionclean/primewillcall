"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type CreateBookingState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  savedBookingId?: string;
};

/**
 * Turn a create_booking() failure into something a staff member can act on. The
 * function raises a short stable token; RLS denials arrive as 42501 the same as
 * they did when the inserts were inline.
 */
function bookingErrorMessage(err: { code?: string; message?: string }): string {
  if (err.code === "42501" || /row-level security/i.test(err.message ?? "")) {
    return "You don't have permission to create bookings.";
  }
  const token = (err.message ?? "").trim();
  switch (true) {
    case token.includes("tour_not_available"):
      return "This tour is not active.";
    case token.includes("bad_slot"):
      return "That timeslot is no longer available.";
    case token.includes("slot_closed"):
      return "That time is closed for the selected date.";
    case token.includes("no_prices"):
      return "This tour has no prices set up yet.";
    case token.includes("no_guests"):
      return "Add at least one guest.";
    default:
      return err.message || "Failed to save booking.";
  }
}

export async function createBookingAction(
  _prev: CreateBookingState,
  formData: FormData,
): Promise<CreateBookingState> {
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: staff } = await supabase
    .from("staff")
    .select("id, role, business_id, is_active, can_create_bookings")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!staff || !staff.is_active) {
    return { error: "Your account isn't set up to create bookings." };
  }
  if (staff.role !== "owner" && !staff.can_create_bookings) {
    return { error: "Your account doesn't have permission to create bookings." };
  }

  const fieldErrors: Record<string, string> = {};

  const business_tour_id = String(formData.get("business_tour_id") ?? "").trim();
  if (!business_tour_id) {
    fieldErrors.business_tour_id = "Pick a tour.";
  }

  const date = String(formData.get("date") ?? "").trim();
  if (!date) {
    fieldErrors.date = "Date is required.";
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fieldErrors.date = "Date must be YYYY-MM-DD.";
  }

  const slotStartRaw = String(formData.get("slot_start") ?? "").trim();
  if (!slotStartRaw) {
    fieldErrors.slot_start = "Pick a timeslot.";
  } else if (!/^\d{2}:\d{2}/.test(slotStartRaw)) {
    fieldErrors.slot_start = "Timeslot is invalid.";
  }
  const slotStart = /^\d{2}:\d{2}$/.test(slotStartRaw)
    ? slotStartRaw
    : slotStartRaw.slice(0, 5);

  const slotDurationRaw = String(formData.get("slot_duration") ?? "").trim();
  const slotDuration = Number(slotDurationRaw);
  if (
    !slotDurationRaw ||
    !Number.isFinite(slotDuration) ||
    !Number.isInteger(slotDuration) ||
    slotDuration <= 0
  ) {
    fieldErrors.slot_start = fieldErrors.slot_start ?? "Timeslot is invalid.";
  }

  const customer_full_name = String(
    formData.get("customer_full_name") ?? "",
  ).trim();
  if (!customer_full_name) {
    fieldErrors.customer_full_name = "Full name is required.";
  } else if (customer_full_name.length > 200) {
    fieldErrors.customer_full_name = "Full name is too long.";
  }

  const customer_email_raw = String(formData.get("customer_email") ?? "").trim();
  const customer_email = customer_email_raw || null;
  if (customer_email && !/.+@.+\..+/.test(customer_email)) {
    fieldErrors.customer_email = "Email looks invalid.";
  }

  const customer_phone_raw = String(formData.get("customer_phone") ?? "").trim();
  const customer_phone = customer_phone_raw || null;

  const notes_raw = String(formData.get("notes") ?? "").trim();
  const notes = notes_raw || null;

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  // Fetch the business_tour and confirm scope.
  const { data: bt, error: btErr } = await supabase
    .from("business_tours")
    .select(
      "id, business_id, name, is_active, tour:tours!business_tours_tour_id_fkey(id, name, capacity, is_active)",
    )
    .eq("id", business_tour_id)
    .maybeSingle();
  if (btErr || !bt) {
    return { error: "Tour not found." };
  }
  const btRow = bt as unknown as {
    id: string;
    business_id: string;
    name: string;
    is_active: boolean;
    tour: { id: string; name: string; is_active: boolean } | null;
  };
  if (!btRow.is_active || !btRow.tour?.is_active) {
    return { error: "This tour is not active." };
  }
  if (staff.role !== "owner" && btRow.business_id !== staff.business_id) {
    return { error: "You can't create bookings for that business." };
  }
  if (staff.role === "check_in") {
    // Check-in staff only sell tours assigned to them (mirrors their RLS scope).
    const { data: assignment } = await supabase
      .from("staff_tours")
      .select("tour_id")
      .eq("staff_id", staff.id)
      .eq("tour_id", btRow.tour?.id ?? "")
      .maybeSingle();
    if (!assignment) {
      return { error: "You can only create bookings for tours assigned to you." };
    }
  }

  // Quantities only. The prices, the breakdown, the slot duration and the UTC
  // timestamps all come from the create_booking() function, so nothing the browser
  // posts can move a price. See supabase/migrations/20260816120000_create_booking_rpc.sql.
  const { data: tiers, error: tiersErr } = await supabase
    .from("tour_pax_tiers")
    .select("id")
    .eq("business_tour_id", business_tour_id);
  if (tiersErr) {
    return { error: tiersErr.message };
  }
  if (!tiers || tiers.length === 0) {
    return { error: "This tour has no prices set up yet." };
  }

  const pax: Record<string, number> = {};
  let totalQty = 0;
  for (const tier of tiers) {
    const raw = formData.get(`pax_${tier.id}`);
    if (raw === null) continue;
    const qty = Number(String(raw));
    if (!Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty)) {
      fieldErrors[`pax_${tier.id}`] = "Invalid quantity.";
      continue;
    }
    if (qty === 0) continue;
    pax[tier.id] = qty;
    totalQty += qty;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  if (totalQty === 0) {
    return { error: "Add at least one guest." };
  }

  // Manual price. Blank means charge the tier prices, which stay the default and
  // the only thing the client can't tamper with. A value here is a deliberate
  // desk-side adjustment (discount, cash deal), so the breakdown keeps the list
  // prices and only the charged total moves.
  let totalOverrideCents: number | null = null;
  const totalOverrideRaw = String(formData.get("total_override") ?? "").trim();
  if (totalOverrideRaw) {
    const cleaned = totalOverrideRaw.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
      return {
        fieldErrors: { total_override: "Enter a price like 60 or 59.99." },
      };
    }
    const cents = Math.round(Number(cleaned) * 100);
    if (cents > 100_000_00) {
      return { fieldErrors: { total_override: "That price is too high." } };
    }
    totalOverrideCents = cents;
  }

  // Customer + booking in one transaction: a failure on the booking no longer
  // leaves an orphan customer behind.
  const { error: rpcErr } = await supabase.rpc("create_booking", {
    p_business_tour_id: business_tour_id,
    p_date: date,
    p_slot_start: slotStart,
    p_customer_name: customer_full_name,
    p_pricing: "tiers",
    p_pax: pax,
    p_customer_email: customer_email ?? undefined,
    p_customer_phone: customer_phone ?? undefined,
    p_notes: notes ?? undefined,
    p_status: "confirmed",
    p_total_override_cents: totalOverrideCents ?? undefined,
    p_created_by_staff_id: staff.id,
    // Staff may deliberately sell a departure that is closed or inactive on the
    // public board (a phone booking), so neither guard applies here.
    p_respect_closures: false,
    p_active_slots_only: false,
  });
  if (rpcErr) {
    return { error: bookingErrorMessage(rpcErr) };
  }

  // Messaging automations are NOT fired here anymore. They run from a single
  // database trigger on `bookings` (on_native_booking_created), which enqueues
  // into scheduled_messages for the capped dispatcher. That path fires for every
  // Supabase-native booking (any source), so keeping this inline call would
  // double-send AND bypass the hourly cap. See docs/messaging-automations.md.

  revalidatePath("/dashboard");
  revalidatePath("/schedule");
  redirect("/dashboard");
}
