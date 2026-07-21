import { cache } from "react";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The signed-in user plus their staff row, fetched once per request.
 *
 * Wrapped in React `cache()` so the (app) layout and the page it renders share
 * a single `getUser()` + staff round-trip on a full page load, instead of each
 * doing their own (they run in the same server render). Pages that also need a
 * Supabase client for data still create one; that part is cheap (it just reads
 * cookies), the network round-trips are what this dedupes.
 */
export const getCurrentStaff = cache(async () => {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, staff: null };

  const { data: staff } = await supabase
    .from("staff")
    .select(
      "id, full_name, role, business_id, is_active, can_create_bookings, can_edit_bookings, can_check_in, can_delete_bookings",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  return { user, staff };
});

export type StaffCapabilities = {
  canCreateBookings: boolean;
  canEditBookings: boolean;
  canCheckIn: boolean;
  canDeleteBookings: boolean;
};

/**
 * Per-staff booking permissions, owner-editable on /admin/staff/[id].
 * Owners always have every capability; the columns only gate managers and
 * check-in staff. RLS + a bookings trigger enforce the same rules server-side.
 */
export function staffCapabilities(staff: {
  role: "owner" | "business_manager" | "check_in";
  can_create_bookings: boolean;
  can_edit_bookings: boolean;
  can_check_in: boolean;
  can_delete_bookings: boolean;
}): StaffCapabilities {
  if (staff.role === "owner") {
    return {
      canCreateBookings: true,
      canEditBookings: true,
      canCheckIn: true,
      canDeleteBookings: true,
    };
  }
  return {
    canCreateBookings: staff.can_create_bookings,
    canEditBookings: staff.can_edit_bookings,
    canCheckIn: staff.can_check_in,
    canDeleteBookings: staff.can_delete_bookings,
  };
}
