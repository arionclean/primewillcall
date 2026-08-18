import { cache } from "react";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The signed-in user plus their staff row, fetched once per request.
 *
 * Identity comes from `getClaims()`, not `getUser()`. `getUser()` is an HTTPS
 * round-trip to the Supabase Auth server on every call; `getClaims()` verifies
 * the access token locally against the project's public signing key (this
 * project signs with ES256), so it costs microseconds and no network. That
 * matters because this runs on the (app) layout for every single navigation.
 * If the token cannot be verified locally, auth-js falls back to the network
 * call on its own, so this is no less strict than before.
 *
 * Wrapped in React `cache()` so the layout, the nested layout and the page all
 * share one staff round-trip per request instead of each doing their own. Every
 * server component and action that needs the current staff row should call this
 * rather than rolling its own `getUser()` + staff select.
 */
export const getCurrentStaff = cache(async () => {
  const supabase = await getSupabaseServerClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) return { user: null, staff: null };

  // Only the id and email are ever read downstream, so the full auth user
  // record (the thing the extra round-trip bought) is not needed.
  const user = { id: claims.sub, email: claims.email ?? null };

  const { data: staff } = await supabase
    .from("staff")
    .select(
      "id, full_name, role, business_id, is_active, kiosk_slug, can_create_bookings, can_edit_bookings, can_check_in, can_delete_bookings, can_add_to_peek",
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
  canAddToPeek: boolean;
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
  can_add_to_peek: boolean;
}): StaffCapabilities {
  if (staff.role === "owner") {
    return {
      canCreateBookings: true,
      canEditBookings: true,
      canCheckIn: true,
      canDeleteBookings: true,
      canAddToPeek: true,
    };
  }
  return {
    canCreateBookings: staff.can_create_bookings,
    canEditBookings: staff.can_edit_bookings,
    canCheckIn: staff.can_check_in,
    canDeleteBookings: staff.can_delete_bookings,
    canAddToPeek: staff.can_add_to_peek,
  };
}
