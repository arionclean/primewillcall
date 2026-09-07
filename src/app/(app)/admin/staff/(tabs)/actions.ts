"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { hashPin, PIN_RE, randomSalt } from "@/lib/kiosk/pin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type PersonActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  saved?: true;
};

const PATH = "/admin/staff";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Employees are one pool shared by every business, managed by the owner and any
 * business manager. Mirrors the RLS policy, which is the real guarantee.
 */
async function canManage(): Promise<string | null> {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active) return "Not signed in.";
  if (staff.role === "owner" || staff.role === "business_manager") return null;
  return "Only the owner or a business manager can manage employees.";
}

/**
 * A PIN identifies a person on any tablet by itself, so it must be unique among
 * every active employee. The check is the `kiosk_pin_in_use` database function,
 * which hashes the candidate with each row's salt and answers only yes or no.
 */
async function pinInUse(pin: string, exceptEmployeeId: string | null): Promise<boolean> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("kiosk_pin_in_use", {
    p_pin: pin,
    p_except: exceptEmployeeId ?? undefined,
  });
  if (error) {
    console.error("[people] kiosk_pin_in_use:", error);
    return true; // refuse rather than risk two people on one PIN
  }
  return Boolean(data);
}

function readPin(formData: FormData): { pin?: string; error?: string } {
  const pin = String(formData.get("pin") ?? "").trim();
  const confirm = String(formData.get("pin_confirm") ?? "").trim();
  if (!PIN_RE.test(pin)) return { error: "The PIN is 4 digits." };
  if (pin !== confirm) return { error: "The two PINs do not match." };
  return { pin };
}

function readId(formData: FormData): string | null {
  const id = String(formData.get("employee_id") ?? "").trim();
  return UUID_RE.test(id) ? id : null;
}

export async function createEmployeeAction(
  _prev: PersonActionState,
  formData: FormData,
): Promise<PersonActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Enter the person's name.";
  const pin = readPin(formData);
  if (pin.error) fieldErrors.pin = pin.error;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const denied = await canManage();
  if (denied) return { error: denied };
  if (await pinInUse(pin.pin!, null)) {
    return { fieldErrors: { pin: "Someone already uses that PIN. Pick another." } };
  }

  const salt = randomSalt();
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("kiosk_employees").insert({
    name,
    pin_salt: salt,
    pin_hash: await hashPin(salt, pin.pin!),
  });
  if (error) return { error: "Could not add the employee. Try again." };
  revalidatePath(PATH);
  return { saved: true };
}

export async function setEmployeePinAction(
  _prev: PersonActionState,
  formData: FormData,
): Promise<PersonActionState> {
  const id = readId(formData);
  if (!id) return { error: "That employee no longer exists." };
  const pin = readPin(formData);
  if (pin.error) return { fieldErrors: { pin: pin.error } };

  const denied = await canManage();
  if (denied) return { error: denied };
  if (await pinInUse(pin.pin!, id)) {
    return { fieldErrors: { pin: "Someone already uses that PIN. Pick another." } };
  }

  const salt = randomSalt();
  const supabase = await getSupabaseServerClient();
  const { error, count } = await supabase
    .from("kiosk_employees")
    .update({ pin_salt: salt, pin_hash: await hashPin(salt, pin.pin!) }, { count: "exact" })
    .eq("id", id);
  if (error) return { error: "Could not change the PIN. Try again." };
  if (!count) return { error: "That employee no longer exists." };
  revalidatePath(PATH);
  return { saved: true };
}

export async function setEmployeeActiveAction(formData: FormData): Promise<void> {
  const id = readId(formData);
  const active = String(formData.get("active") ?? "") === "1";
  if (!id || (await canManage())) return;
  const supabase = await getSupabaseServerClient();
  await supabase.from("kiosk_employees").update({ is_active: active }).eq("id", id);
  revalidatePath(PATH);
}

/** Removes the person. Their past activity, sales and bookings keep the name, not the link. */
export async function deleteEmployeeAction(formData: FormData): Promise<void> {
  const id = readId(formData);
  if (!id || (await canManage())) return;
  const supabase = await getSupabaseServerClient();
  await supabase.from("kiosk_employees").delete().eq("id", id);
  revalidatePath(PATH);
}
