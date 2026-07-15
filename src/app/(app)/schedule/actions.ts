"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type CreateBookingState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  savedBookingId?: string;
};

type PaxLine = {
  tier_id: string;
  label: string;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
};

function nyLocalToUtcIso(yyyyMmDd: string, hhmm: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const parts = hhmm.split(":").map(Number);
  const hh = parts[0] ?? 0;
  const mm = parts[1] ?? 0;
  const candidate = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const tzLabel =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "shortOffset",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(candidate)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m2 = tzLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m2?.[1] === "-" ? -1 : 1;
  const offMin = sign * (Number(m2?.[2] ?? 0) * 60 + Number(m2?.[3] ?? 0));
  return new Date(candidate.getTime() - offMin * 60_000).toISOString();
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
    .select("id, role, business_id, is_active")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!staff || !staff.is_active) {
    return { error: "Your account isn't set up to create bookings." };
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

  // Authoritative tier prices.
  const { data: tiers, error: tiersErr } = await supabase
    .from("tour_pax_tiers")
    .select("id, label, price_cents, sort_order")
    .eq("business_tour_id", business_tour_id)
    .order("sort_order", { ascending: true });
  if (tiersErr) {
    return { error: tiersErr.message };
  }
  if (!tiers || tiers.length === 0) {
    return { error: "This tour has no pax tiers configured." };
  }

  // Build pax breakdown.
  const breakdown: PaxLine[] = [];
  let total_cents = 0;
  let pax_adult = 0;
  let pax_child = 0;
  let pax_infant = 0;
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
    const line_total_cents = qty * tier.price_cents;
    total_cents += line_total_cents;
    totalQty += qty;
    breakdown.push({
      tier_id: tier.id,
      label: tier.label,
      qty,
      unit_price_cents: tier.price_cents,
      line_total_cents,
    });
    const lower = tier.label.toLowerCase();
    if (lower === "adult") pax_adult += qty;
    else if (lower === "child") pax_child += qty;
    else if (lower === "infant") pax_infant += qty;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  if (totalQty === 0) {
    return { error: "Add at least one guest." };
  }

  // Compute times.
  const startsAtIso = nyLocalToUtcIso(date, slotStart);
  const endsAtIso = new Date(
    new Date(startsAtIso).getTime() + slotDuration * 60_000,
  ).toISOString();

  // Insert customer.
  const { data: customerRow, error: custErr } = await supabase
    .from("customers")
    .insert({
      business_id: btRow.business_id,
      full_name: customer_full_name,
      email: customer_email,
      phone: customer_phone,
    })
    .select("id")
    .single();
  if (custErr || !customerRow) {
    const msg = custErr?.message ?? "Failed to save customer.";
    if (
      custErr?.code === "42501" ||
      /row-level security/i.test(custErr?.message ?? "")
    ) {
      return { error: "You don't have permission to add customers." };
    }
    return { error: msg };
  }

  // Insert booking.
  const { data: bookingRow, error: bookingErr } = await supabase
    .from("bookings")
    .insert({
      business_id: btRow.business_id,
      business_tour_id: btRow.id,
      customer_id: customerRow.id,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      status: "confirmed",
      total_cents,
      currency: "usd",
      notes,
      created_by_staff_id: staff.id,
      pax_adult,
      pax_child,
      pax_infant,
      tour_pax_breakdown: breakdown,
    })
    .select("id, public_token")
    .single();
  if (bookingErr || !bookingRow) {
    if (
      bookingErr?.code === "42501" ||
      /row-level security/i.test(bookingErr?.message ?? "")
    ) {
      return { error: "You don't have permission to create bookings." };
    }
    return { error: bookingErr?.message ?? "Failed to save booking." };
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
