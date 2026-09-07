"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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
 * People are one pool shared by every business, managed by the owner and any
 * business manager. Mirrors the RLS policy, which is the real guarantee.
 */
async function canManage(): Promise<string | null> {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active) return "Not signed in.";
  if (staff.role === "owner" || staff.role === "business_manager") return null;
  return "Only the owner or a business manager can manage people.";
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

function readPin(formData: FormData, required: boolean): { pin?: string; error?: string } {
  const pin = String(formData.get("pin") ?? "").trim();
  const confirm = String(formData.get("pin_confirm") ?? "").trim();
  if (!pin && !confirm && !required) return {};
  if (!PIN_RE.test(pin)) return { error: "The PIN is 4 digits." };
  if (pin !== confirm) return { error: "The two PINs do not match." };
  return { pin };
}

function readUuid(formData: FormData, field: string): string | null {
  const v = String(formData.get(field) ?? "").trim();
  return UUID_RE.test(v) ? v : null;
}

/**
 * Add a person: a name plus their PIN, and optionally a website login too. The
 * login is the existing New team member form, opened with the name filled in and
 * the person attached, so the two end up as one card.
 */
export async function createPersonAction(
  _prev: PersonActionState,
  formData: FormData,
): Promise<PersonActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const wantsLogin = String(formData.get("login") ?? "") === "1";
  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Enter the person's name.";
  const pin = readPin(formData, !wantsLogin);
  if (pin.error) fieldErrors.pin = pin.error;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const denied = await canManage();
  if (denied) return { error: denied };

  let employeeId: string | null = null;
  if (pin.pin) {
    if (await pinInUse(pin.pin, null)) {
      return { fieldErrors: { pin: "Someone already uses that PIN. Pick another." } };
    }
    const salt = randomSalt();
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("kiosk_employees")
      .insert({ name, pin_salt: salt, pin_hash: await hashPin(salt, pin.pin) })
      .select("id")
      .single();
    if (error) return { error: "Could not add the person. Try again." };
    employeeId = data.id;
  }

  revalidatePath(PATH);
  if (wantsLogin) {
    const q = new URLSearchParams({ name });
    if (employeeId) q.set("person", employeeId);
    redirect(`/admin/staff/new?${q.toString()}`);
  }
  return { saved: true };
}

/**
 * Set or change a person's PIN. For someone who so far only has a website login,
 * this creates their PIN row and links it to the login.
 */
export async function setPersonPinAction(
  _prev: PersonActionState,
  formData: FormData,
): Promise<PersonActionState> {
  const employeeId = readUuid(formData, "employee_id");
  const staffId = readUuid(formData, "staff_id");
  const name = String(formData.get("name") ?? "").trim();
  if (!employeeId && !staffId) return { error: "That person no longer exists." };
  const pin = readPin(formData, true);
  if (pin.error) return { fieldErrors: { pin: pin.error } };

  const denied = await canManage();
  if (denied) return { error: denied };
  if (await pinInUse(pin.pin!, employeeId)) {
    return { fieldErrors: { pin: "Someone already uses that PIN. Pick another." } };
  }

  const salt = randomSalt();
  const pin_hash = await hashPin(salt, pin.pin!);
  const supabase = await getSupabaseServerClient();
  if (employeeId) {
    const { error, count } = await supabase
      .from("kiosk_employees")
      .update({ pin_salt: salt, pin_hash }, { count: "exact" })
      .eq("id", employeeId);
    if (error) return { error: "Could not change the PIN. Try again." };
    if (!count) return { error: "That person no longer exists." };
  } else {
    const { error } = await supabase
      .from("kiosk_employees")
      .insert({ name: name || "Team member", staff_id: staffId, pin_salt: salt, pin_hash });
    if (error) return { error: "Could not set the PIN. Try again." };
  }
  revalidatePath(PATH);
  return { saved: true };
}

/** Pause or resume a PIN. The person keeps their card; the PIN just stops working. */
export async function setEmployeeActiveAction(formData: FormData): Promise<void> {
  const id = readUuid(formData, "employee_id");
  const active = String(formData.get("active") ?? "") === "1";
  if (!id || (await canManage())) return;
  const supabase = await getSupabaseServerClient();
  await supabase.from("kiosk_employees").update({ is_active: active }).eq("id", id);
  revalidatePath(PATH);
}

/** Removes a PIN-only person. Their past activity, sales and bookings keep the name, not the link. */
export async function deleteEmployeeAction(formData: FormData): Promise<void> {
  const id = readUuid(formData, "employee_id");
  if (!id || (await canManage())) return;
  const supabase = await getSupabaseServerClient();
  await supabase.from("kiosk_employees").delete().eq("id", id);
  revalidatePath(PATH);
}

/**
 * Accounts: the shared desk logins. One switch decides whether that desk asks
 * for a PIN, on its computer (staff.pin_required) and on its tablet
 * (kiosks.pin_required, by the account's kiosk slug). Owner only.
 */
export async function setAccountPinAction(formData: FormData): Promise<void> {
  const { staff: me } = await getCurrentStaff();
  if (me?.role !== "owner") return;
  const id = readUuid(formData, "staff_id");
  const on = String(formData.get("on") ?? "") === "1";
  if (!id) return;
  const supabase = await getSupabaseServerClient();
  const { data: account } = await supabase
    .from("staff")
    .select("id, role, kiosk_slug")
    .eq("id", id)
    .maybeSingle();
  if (!account || account.role !== "check_in") return;
  const { error } = await supabase.from("staff").update({ pin_required: on }).eq("id", id);
  if (error) {
    console.error("[accounts] pin switch:", error);
    return;
  }
  if (account.kiosk_slug) {
    const { error: kioskErr } = await supabase
      .from("kiosks")
      .update({ pin_required: on })
      .eq("slug", account.kiosk_slug);
    if (kioskErr) console.error("[accounts] tablet pin switch:", kioskErr);
  }
  revalidatePath(`${PATH}/accounts`);
}
