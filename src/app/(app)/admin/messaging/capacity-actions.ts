"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type CapacityAlertState = { error?: string; saved?: true };

async function requireOwner() {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active || staff.role !== "owner") return null;
  return staff;
}

/** Every capacity alert at once. Off means the bookings triggers make no call. */
export async function setSlotAlertsEnabledAction(enabled: boolean): Promise<CapacityAlertState> {
  if (!(await requireOwner())) return { error: "Only the owner can change this." };

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("messaging_settings")
    .update({ slot_alerts_enabled: enabled })
    .eq("id", true);

  if (error) return { error: error.message };

  revalidatePath("/admin/messaging");
  return { saved: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create or update one alert: its name, the products it watches, the seat count
 * that sets it off, and who hears about it.
 *
 * Products are replaced wholesale rather than diffed. The list is a handful of
 * rows and the screen always posts the complete set, so a delete plus an insert
 * is both simpler and impossible to leave half applied.
 */
export async function saveCapacityAlertAction(
  _prev: CapacityAlertState,
  formData: FormData,
): Promise<CapacityAlertState> {
  if (!(await requireOwner())) return { error: "Only the owner can change this." };

  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Give the alert a name." };

  const threshold = Number(String(formData.get("threshold_pax") ?? "").trim());
  if (!Number.isInteger(threshold) || threshold < 1) {
    return { error: "Enter a whole number of guests, 1 or more." };
  }

  const tourIds = formData.getAll("tour_id").map((value) => String(value));
  if (tourIds.length === 0) return { error: "Pick at least one product to watch." };

  const phones = formData
    .getAll("phone")
    .map((value) => String(value).replace(/\D+/g, ""))
    .filter((digits) => digits.length >= 10);

  const emails = formData
    .getAll("email")
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  const badEmail = emails.find((email) => !EMAIL_RE.test(email));
  if (badEmail) return { error: `That email does not look right: ${badEmail}` };

  if (phones.length === 0 && emails.length === 0) {
    return { error: "Add a phone number or an email, otherwise nobody hears about it." };
  }

  const supabase = await getSupabaseServerClient();
  const fields = { name, threshold_pax: threshold, phones, emails, is_active: true };

  let alertId = id;
  if (alertId) {
    const { error } = await supabase.from("capacity_alerts").update(fields).eq("id", alertId);
    if (error) return { error: error.message };
  } else {
    const { data, error } = await supabase
      .from("capacity_alerts")
      .insert(fields)
      .select("id")
      .single();
    if (error) return { error: error.message };
    alertId = data.id;
  }

  const { error: clearError } = await supabase
    .from("capacity_alert_tours")
    .delete()
    .eq("alert_id", alertId);
  if (clearError) return { error: clearError.message };

  const { error: linkError } = await supabase
    .from("capacity_alert_tours")
    .insert(tourIds.map((tourId) => ({ alert_id: alertId, tour_id: tourId })));

  // The unique index says a product belongs to one alert. That is the only way
  // this insert fails, so name the cause instead of showing the database's.
  if (linkError) {
    return { error: "One of those products is already watched by another alert." };
  }

  revalidatePath("/admin/messaging");
  return { saved: true };
}

/** Remove an alert. Its products and its already-alerted history go with it. */
export async function deleteCapacityAlertAction(formData: FormData): Promise<void> {
  if (!(await requireOwner())) return;

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const supabase = await getSupabaseServerClient();
  await supabase.from("capacity_alerts").delete().eq("id", id);

  revalidatePath("/admin/messaging");
}
