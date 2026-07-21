"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type StaffRole = "owner" | "business_manager" | "check_in";

export type CreateStaffState = {
  error?: string;
  fieldErrors?: Partial<
    Record<"full_name" | "email" | "role" | "business_id" | "password", string>
  >;
  warning?: string;
};

// Owner intentionally excluded — new owners must be created via the
// Supabase dashboard, by design.
const VALID_ROLES: StaffRole[] = ["business_manager", "check_in"];

export async function createStaffAction(
  _prev: CreateStaffState,
  formData: FormData,
): Promise<CreateStaffState> {
  const supabase = await getSupabaseServerClient();

  const full_name = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const roleRaw = String(formData.get("role") ?? "").trim();
  const business_id_raw = String(formData.get("business_id") ?? "").trim();
  const passwordRaw = String(formData.get("password") ?? "");
  const can_create_bookings = formData.get("can_create_bookings") === "1";
  const can_edit_bookings = formData.get("can_edit_bookings") === "1";
  const can_check_in = formData.get("can_check_in") === "1";
  const can_delete_bookings = formData.get("can_delete_bookings") === "1";
  const tour_ids = formData
    .getAll("tour_ids")
    .map((v) => String(v))
    .filter(Boolean);

  const fieldErrors: CreateStaffState["fieldErrors"] = {};
  if (!full_name) fieldErrors.full_name = "Name is required.";
  if (!email) fieldErrors.email = "Email is required.";
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fieldErrors.email = "That doesn't look like a valid email.";
  }
  if (!VALID_ROLES.includes(roleRaw as StaffRole)) {
    fieldErrors.role = "Pick a role.";
  }
  const role = roleRaw as StaffRole;
  const business_id =
    role === "owner" ? null : business_id_raw || null;
  if (role !== "owner" && !business_id) {
    fieldErrors.business_id =
      "A business is required for managers and check-in staff.";
  }
  // Empty password = use the invite flow. Anything non-empty must meet
  // Supabase's minimum (6) to avoid a confusing server error later.
  if (passwordRaw && passwordRaw.length < 6) {
    fieldErrors.password = "Password must be at least 6 characters.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const { data: inserted, error: insErr } = await supabase
    .from("staff")
    .insert({
      full_name,
      email,
      role,
      business_id,
      can_create_bookings,
      can_edit_bookings,
      can_check_in,
      can_delete_bookings,
    })
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") {
      return {
        fieldErrors: {
          email:
            "Another team member already has this email. Use a different one or remove the existing record first.",
        },
      };
    }
    return { error: insErr.message };
  }

  // Check-in staff: link to selected master tours via staff_tours.
  if (role === "check_in" && tour_ids.length > 0) {
    const rows = tour_ids.map((tid) => ({ staff_id: inserted.id, tour_id: tid }));
    const { error: linkErr } = await supabase.from("staff_tours").insert(rows);
    if (linkErr) {
      return {
        error: `Team member saved but tour assignments failed: ${linkErr.message}`,
      };
    }
  }

  // Either create the auth user with a chosen password, or send them an email
  // invite to set their own. Both require the service role key.
  let warning: string | undefined;
  const admin = getSupabaseAdminClient();
  if (admin) {
    if (passwordRaw) {
      const { error: createErr } = await admin.auth.admin.createUser({
        email,
        password: passwordRaw,
        email_confirm: true,
      });
      if (createErr) {
        // Roll the staff row back so the admin can retry from a clean state.
        await supabase.from("staff").delete().eq("id", inserted.id);
        return { error: `Could not create login: ${createErr.message}` };
      }
    } else {
      const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
      if (inviteErr) {
        warning = `Saved, but the invite email couldn't be sent: ${inviteErr.message}. Open the team member and set a password instead.`;
      }
    }
  } else {
    warning =
      passwordRaw
        ? "Saved, but the login couldn't be created. Open the team member and set the password again to finish."
        : "Saved, but the invite email couldn't be sent. Open the team member and set a password instead.";
  }

  revalidatePath("/admin/staff");
  revalidatePath("/admin");
  if (warning) {
    // Stash the warning via redirect query param so the list page can show it.
    redirect(
      `/admin/staff?notice=${encodeURIComponent(warning)}`,
    );
  }
  redirect("/admin/staff");
}
