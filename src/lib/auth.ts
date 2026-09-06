import { cache } from "react";

import type { Database } from "@/lib/supabase/database.types";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type StaffRole = Database["public"]["Enums"]["staff_role"];

/** What the app needs to know about the signed-in staffer. */
export type CurrentStaff = {
  id: string;
  full_name: string;
  role: StaffRole;
  business_id: string | null;
  is_active: boolean;
  kiosk_slug: string | null;
  can_create_bookings: boolean;
  can_edit_bookings: boolean;
  can_check_in: boolean;
  can_delete_bookings: boolean;
  can_add_to_peek: boolean;
  can_view_attachments: boolean;
  can_redeem_groupon: boolean;
  can_view_details: boolean;
};

/**
 * Reads the staff row out of the `app_staff` claim the custom access token hook
 * writes (see the staff_claims_hook migration). Returns undefined when the
 * claim is missing, which means either the hook is not enabled yet or the token
 * predates it, and the caller should ask the database instead.
 */
function staffFromClaims(claims: Record<string, unknown>): CurrentStaff | null | undefined {
  if (!("app_staff" in claims)) return undefined;
  const raw = claims.app_staff;
  if (raw === null) return null; // signed in, but not on the team
  if (typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.role !== "string") return undefined;
  // A token minted before a permission column existed says nothing about it,
  // so it is treated like one that predates the hook. Point this at the
  // newest column whenever one ships.
  if (!("can_view_details" in s)) return undefined;
  return {
    id: s.id,
    full_name: typeof s.full_name === "string" ? s.full_name : "",
    role: s.role as StaffRole,
    business_id: typeof s.business_id === "string" ? s.business_id : null,
    is_active: s.is_active === true,
    kiosk_slug: typeof s.kiosk_slug === "string" ? s.kiosk_slug : null,
    can_create_bookings: s.can_create_bookings === true,
    can_edit_bookings: s.can_edit_bookings === true,
    can_check_in: s.can_check_in === true,
    can_delete_bookings: s.can_delete_bookings === true,
    can_add_to_peek: s.can_add_to_peek === true,
    can_view_attachments: s.can_view_attachments === true,
    can_redeem_groupon: s.can_redeem_groupon === true,
    can_view_details: s.can_view_details === true,
  };
}

/**
 * The signed-in user plus their staff row, fetched once per request.
 *
 * Neither part costs a round trip in the normal case. Identity comes from
 * `getClaims()`, which verifies the access token locally against the project's
 * ES256 signing key rather than calling the Auth server. The staff row rides
 * along in the same token, written there by the `custom_access_token_hook`
 * database function, so the layout no longer runs a query to answer "who is
 * this?" on every navigation. That query was 140 to 200ms of every screen.
 *
 * The database is still consulted whenever the token cannot answer: before the
 * hook is enabled, and for any session issued earlier. That fallback is what
 * makes this safe to deploy in either order.
 *
 * The claims only drive the UI. RLS calls `current_staff()`, which reads the
 * live table on every statement, so what someone can actually touch changes on
 * their next query regardless of what their token says. Left alone, the token
 * would lag a permission edit by up to its lifetime (about an hour), which is
 * why `StaffClaimsSync` (mounted by the `(app)` layout) watches the staffer's
 * own row over Realtime and refreshes the session the moment it changes. An
 * edit shows on an open screen within a second; the token lifetime is only
 * the ceiling for a browser that was offline the whole time.
 *
 * Wrapped in React `cache()` so the layout, any nested layout and the page
 * share one result per request.
 */
export const getCurrentStaff = cache(async () => {
  const supabase = await getSupabaseServerClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) return { user: null, staff: null };

  const user = { id: claims.sub, email: claims.email ?? null };

  const fromToken = staffFromClaims(claims as unknown as Record<string, unknown>);
  if (fromToken !== undefined) return { user, staff: fromToken };

  const { data: staff } = await supabase
    .from("staff")
    .select(
      "id, full_name, role, business_id, is_active, kiosk_slug, can_create_bookings, can_edit_bookings, can_check_in, can_delete_bookings, can_add_to_peek, can_view_attachments, can_redeem_groupon, can_view_details",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  return { user, staff: staff as CurrentStaff | null };
});

export type StaffCapabilities = {
  canCreateBookings: boolean;
  canEditBookings: boolean;
  canCheckIn: boolean;
  canDeleteBookings: boolean;
  canAddToPeek: boolean;
  /** Open the photos attached to a booking. Screen-level. */
  canViewAttachments: boolean;
  /** See Redemption Codes and mark a Groupon voucher redeemed. */
  canRedeemGroupon: boolean;
  /** Off: only ID, name, phone, guests and check-in status. Screen-level. */
  canViewDetails: boolean;
};

/**
 * Per-staff booking permissions, owner-editable on /admin/staff/[id].
 * Owners always have every capability; the columns only gate managers and
 * check-in staff. The write permissions are enforced by RLS plus the bookings
 * update trigger; the two view switches decide what the bookings page fetches
 * and shows (RLS is row-level and cannot hide a column).
 */
export function staffCapabilities(staff: {
  role: StaffRole;
  can_create_bookings: boolean;
  can_edit_bookings: boolean;
  can_check_in: boolean;
  can_delete_bookings: boolean;
  can_add_to_peek: boolean;
  can_view_attachments: boolean;
  can_redeem_groupon: boolean;
  can_view_details: boolean;
}): StaffCapabilities {
  if (staff.role === "owner") {
    return {
      canCreateBookings: true,
      canEditBookings: true,
      canCheckIn: true,
      canDeleteBookings: true,
      canAddToPeek: true,
      canViewAttachments: true,
      canRedeemGroupon: true,
      canViewDetails: true,
    };
  }
  return {
    canCreateBookings: staff.can_create_bookings,
    canEditBookings: staff.can_edit_bookings,
    canCheckIn: staff.can_check_in,
    canDeleteBookings: staff.can_delete_bookings,
    canAddToPeek: staff.can_add_to_peek,
    canViewAttachments: staff.can_view_attachments,
    canRedeemGroupon: staff.can_redeem_groupon,
    canViewDetails: staff.can_view_details,
  };
}
