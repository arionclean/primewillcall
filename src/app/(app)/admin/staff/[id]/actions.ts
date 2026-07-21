"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type StaffRole = "owner" | "business_manager" | "check_in";

export type UpdateStaffState = {
  error?: string;
  fieldErrors?: Partial<
    Record<"full_name" | "role" | "business_id" | "password", string>
  >;
  saved?: true;
};

// Owner intentionally excluded — owners can't be created or modified through
// the app for safety. Use the Supabase dashboard.
const EDITABLE_ROLES: StaffRole[] = ["business_manager", "check_in"];

export async function updateStaffAction(
  id: string,
  _prev: UpdateStaffState,
  formData: FormData,
): Promise<UpdateStaffState> {
  const supabase = await getSupabaseServerClient();

  // Block the action if the target is an owner. Defense in depth — the page
  // also refuses to render the form for owners.
  const { data: current, error: readErr } = await supabase
    .from("staff")
    .select("id, role, user_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!current) return { error: "Team member not found." };
  if (current.role === "owner") {
    return {
      error: "Owner accounts can't be edited from here.",
    };
  }

  const full_name = String(formData.get("full_name") ?? "").trim();
  const roleRaw = String(formData.get("role") ?? "").trim();
  const business_id_raw = String(formData.get("business_id") ?? "").trim();
  const passwordRaw = String(formData.get("password") ?? "");
  const is_active = formData.get("is_active") === "1";
  const can_create_bookings = formData.get("can_create_bookings") === "1";
  const can_edit_bookings = formData.get("can_edit_bookings") === "1";
  const can_check_in = formData.get("can_check_in") === "1";
  const can_delete_bookings = formData.get("can_delete_bookings") === "1";
  const tour_ids = formData
    .getAll("tour_ids")
    .map((v) => String(v))
    .filter(Boolean);

  const fieldErrors: UpdateStaffState["fieldErrors"] = {};
  if (!full_name) fieldErrors.full_name = "Name is required.";
  if (!EDITABLE_ROLES.includes(roleRaw as StaffRole)) {
    fieldErrors.role = "Pick a role.";
  }
  const role = roleRaw as StaffRole;
  const business_id = business_id_raw || null;
  if (!business_id) {
    fieldErrors.business_id = "A business is required.";
  }
  if (passwordRaw && passwordRaw.length < 6) {
    fieldErrors.password = "Password must be at least 6 characters.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const { error: updErr } = await supabase
    .from("staff")
    .update({
      full_name,
      role,
      business_id,
      is_active,
      can_create_bookings,
      can_edit_bookings,
      can_check_in,
      can_delete_bookings,
    })
    .eq("id", id);
  if (updErr) return { error: updErr.message };

  // Sync staff_tours: only meaningful when role is check_in. When role
  // switches away from check_in, drop all linkages.
  const { data: existing } = await supabase
    .from("staff_tours")
    .select("tour_id")
    .eq("staff_id", id);
  const existingIds = new Set((existing ?? []).map((r) => r.tour_id));
  const target = role === "check_in" ? new Set(tour_ids) : new Set<string>();

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const t of target) if (!existingIds.has(t)) toAdd.push(t);
  for (const t of existingIds) if (!target.has(t)) toRemove.push(t);

  if (toAdd.length > 0) {
    const { error: addErr } = await supabase
      .from("staff_tours")
      .insert(toAdd.map((tid) => ({ staff_id: id, tour_id: tid })));
    if (addErr) return { error: `Tour assignments failed: ${addErr.message}` };
  }
  if (toRemove.length > 0) {
    const { error: delErr } = await supabase
      .from("staff_tours")
      .delete()
      .eq("staff_id", id)
      .in("tour_id", toRemove);
    if (delErr) return { error: `Could not remove tour assignment: ${delErr.message}` };
  }

  // Optional password reset.
  if (passwordRaw) {
    const admin = getSupabaseAdminClient();
    if (!admin) {
      return {
        error:
          "Saved everything else, but the password couldn't be reset. Try again in a moment.",
      };
    }
    if (!current.user_id) {
      return {
        error:
          "Saved everything else, but this team member doesn't have a login yet, so the password can't be set.",
      };
    }
    const { error: pwErr } = await admin.auth.admin.updateUserById(
      current.user_id,
      { password: passwordRaw },
    );
    if (pwErr) {
      return { error: `Saved, but password reset failed: ${pwErr.message}` };
    }
  }

  revalidatePath("/admin/staff");
  revalidatePath(`/admin/staff/${id}`);
  revalidatePath("/admin");
  return { saved: true };
}

export type DeleteStaffState = { error?: string };

export async function deleteStaffAction(
  id: string,
): Promise<DeleteStaffState> {
  const supabase = await getSupabaseServerClient();
  const { data: current } = await supabase
    .from("staff")
    .select("id, role, user_id")
    .eq("id", id)
    .maybeSingle();

  if (!current) return { error: "Team member not found." };
  if (current.role === "owner") {
    return { error: "Owner accounts can't be deleted from here." };
  }

  // Delete the staff row first; staff_tours cascade. Foreign keys from
  // bookings (created_by, checked_in_by) are ON DELETE SET NULL, so they
  // won't block.
  const { error: delErr } = await supabase.from("staff").delete().eq("id", id);
  if (delErr) {
    if (delErr.code === "23503") {
      return {
        error:
          "Couldn't delete: this team member is still referenced by other records.",
      };
    }
    return { error: delErr.message };
  }

  // Best-effort: also remove the linked auth user so they can no longer sign in.
  if (current.user_id) {
    const admin = getSupabaseAdminClient();
    if (admin) {
      await admin.auth.admin.deleteUser(current.user_id);
    }
  }

  revalidatePath("/admin/staff");
  revalidatePath("/admin");
  redirect("/admin/staff");
}
