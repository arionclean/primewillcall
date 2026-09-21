"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { nyLocalToUtcIso } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The owner's corrections on the Hours screen: fix the times of a shift, agree
 * with one the nightly job closed, or remove a punch that should not be there.
 *
 * Owner only, checked here and again by the time_clock_shifts policy. Every one
 * of these writes goes through the log_staff_change trigger, so who changed what
 * is on the Activity tab like any other edit.
 */

export type HoursActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  saved?: true;
};

const PATH = "/admin/staff/hours";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function ownerOnly(): Promise<string | null> {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active) return "Not signed in.";
  if (staff.role !== "owner") return "Only the owner can change hours.";
  return null;
}

function readId(formData: FormData): string | null {
  const id = String(formData.get("shift_id") ?? "").trim();
  return UUID_RE.test(id) ? id : null;
}

/**
 * Set the times of one shift. The day and the two clock times are read in
 * business time; an end at or before the start belongs to the next day (a desk
 * that closes at 1 AM), which is why there is one date field and not two.
 *
 * Saving also clears the "forgot to clock out" flag: the owner has just said
 * what the times are.
 */
export async function updateShiftAction(
  _prev: HoursActionState,
  formData: FormData,
): Promise<HoursActionState> {
  const id = readId(formData);
  const day = String(formData.get("day") ?? "").trim();
  const inTime = String(formData.get("in_time") ?? "").trim();
  const outTime = String(formData.get("out_time") ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!DAY_RE.test(day)) fieldErrors.day = "Pick a date.";
  if (!TIME_RE.test(inTime)) fieldErrors.in_time = "Enter a time like 09:00.";
  if (outTime && !TIME_RE.test(outTime)) fieldErrors.out_time = "Enter a time like 17:30.";
  if (!id) return { error: "That shift is gone. Refresh the page." };
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const denied = await ownerOnly();
  if (denied) return { error: denied };

  const clockIn = nyLocalToUtcIso(day, inTime);
  let clockOut: string | null = null;
  if (outTime) {
    clockOut = nyLocalToUtcIso(day, outTime);
    if (new Date(clockOut) <= new Date(clockIn)) {
      // Ended the next morning.
      const [y, m, d] = day.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      clockOut = nyLocalToUtcIso(next, outTime);
    }
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("time_clock_shifts")
    .update({
      clock_in_at: clockIn,
      clock_out_at: clockOut,
      edited_at: new Date().toISOString(),
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[hours] update failed:", error);
    // The partial unique index: this person already has another shift open.
    if (error.code === "23505") {
      return { error: "That person already has a shift running. Close that one first." };
    }
    return { error: "Could not save the change. Try again." };
  }

  revalidatePath(PATH);
  return { saved: true };
}

/** "Looks right": keep the times the nightly job wrote and drop the flag. */
export async function confirmShiftAction(formData: FormData): Promise<void> {
  const id = readId(formData);
  if (!id) return;
  if (await ownerOnly()) return;

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("time_clock_shifts")
    .update({ reviewed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("[hours] confirm failed:", error);
  revalidatePath(PATH);
}

/** A punch that should never have happened (a test, a double tap). */
export async function deleteShiftAction(formData: FormData): Promise<void> {
  const id = readId(formData);
  if (!id) return;
  if (await ownerOnly()) return;

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("time_clock_shifts").delete().eq("id", id);
  if (error) console.error("[hours] delete failed:", error);
  revalidatePath(PATH);
}
