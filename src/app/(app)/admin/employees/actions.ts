"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { hashPin, PIN_RE, randomSalt } from "@/lib/kiosk/pin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type EmployeeActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  saved?: true;
};

const PATH = "/admin/employees";

/** Owner manages everyone; a business manager only their own business. */
async function canManage(businessId: string): Promise<string | null> {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active) return "Not signed in.";
  if (staff.role === "owner") return null;
  if (staff.role === "business_manager" && staff.business_id === businessId) return null;
  return "You can only manage employees of your own business.";
}

/**
 * A PIN identifies a person on that business's tablets by itself, so it must be
 * unique among the active employees of the business. Hashes are salted per row,
 * so uniqueness is checked by hashing the candidate with every salt (a handful).
 */
async function pinInUse(
  businessId: string,
  pin: string,
  exceptEmployeeId: string | null,
): Promise<boolean> {
  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("kiosk_employees")
    .select("id, pin_hash, pin_salt")
    .eq("business_id", businessId)
    .eq("is_active", true);
  for (const e of data ?? []) {
    if (e.id === exceptEmployeeId) continue;
    if ((await hashPin(e.pin_salt, businessId, pin)) === e.pin_hash) return true;
  }
  return false;
}

function readPin(formData: FormData): { pin?: string; error?: string } {
  const pin = String(formData.get("pin") ?? "").trim();
  const confirm = String(formData.get("pin_confirm") ?? "").trim();
  if (!PIN_RE.test(pin)) return { error: "The PIN is 4 digits." };
  if (pin !== confirm) return { error: "The two PINs do not match." };
  return { pin };
}

export async function createEmployeeAction(
  _prev: EmployeeActionState,
  formData: FormData,
): Promise<EmployeeActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const businessId = String(formData.get("business_id") ?? "").trim();
  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Enter the person's name.";
  if (!businessId) fieldErrors.business_id = "Pick a business.";
  const pin = readPin(formData);
  if (pin.error) fieldErrors.pin = pin.error;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const denied = await canManage(businessId);
  if (denied) return { error: denied };
  if (await pinInUse(businessId, pin.pin!, null)) {
    return { fieldErrors: { pin: "Someone in this business already uses that PIN. Pick another." } };
  }

  const salt = randomSalt();
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("kiosk_employees").insert({
    business_id: businessId,
    name,
    pin_salt: salt,
    pin_hash: await hashPin(salt, businessId, pin.pin!),
  });
  if (error) return { error: "Could not add the employee. Try again." };
  revalidatePath(PATH);
  return { saved: true };
}

export async function setEmployeePinAction(
  _prev: EmployeeActionState,
  formData: FormData,
): Promise<EmployeeActionState> {
  const id = String(formData.get("employee_id") ?? "").trim();
  const pin = readPin(formData);
  if (pin.error) return { fieldErrors: { pin: pin.error } };

  const supabase = await getSupabaseServerClient();
  const { data: employee } = await supabase
    .from("kiosk_employees")
    .select("id, business_id")
    .eq("id", id)
    .maybeSingle();
  if (!employee) return { error: "That employee no longer exists." };
  const denied = await canManage(employee.business_id);
  if (denied) return { error: denied };
  if (await pinInUse(employee.business_id, pin.pin!, employee.id)) {
    return { fieldErrors: { pin: "Someone in this business already uses that PIN. Pick another." } };
  }

  const salt = randomSalt();
  const { error } = await supabase
    .from("kiosk_employees")
    .update({ pin_salt: salt, pin_hash: await hashPin(salt, employee.business_id, pin.pin!) })
    .eq("id", employee.id);
  if (error) return { error: "Could not change the PIN. Try again." };
  revalidatePath(PATH);
  return { saved: true };
}

export async function setEmployeeActiveAction(formData: FormData): Promise<void> {
  const id = String(formData.get("employee_id") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "1";
  const supabase = await getSupabaseServerClient();
  const { data: employee } = await supabase
    .from("kiosk_employees")
    .select("id, business_id")
    .eq("id", id)
    .maybeSingle();
  if (!employee) return;
  if (await canManage(employee.business_id)) return;
  await supabase.from("kiosk_employees").update({ is_active: active }).eq("id", employee.id);
  revalidatePath(PATH);
}

/** Removes the person. Their past activity, sales and bookings keep the name, not the link. */
export async function deleteEmployeeAction(formData: FormData): Promise<void> {
  const id = String(formData.get("employee_id") ?? "").trim();
  const supabase = await getSupabaseServerClient();
  const { data: employee } = await supabase
    .from("kiosk_employees")
    .select("id, business_id")
    .eq("id", id)
    .maybeSingle();
  if (!employee) return;
  if (await canManage(employee.business_id)) return;
  await supabase.from("kiosk_employees").delete().eq("id", employee.id);
  revalidatePath(PATH);
}
