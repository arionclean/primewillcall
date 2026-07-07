import { NextRequest, NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export type StaffRole = "owner" | "business_manager" | "check_in";

export interface StaffContext {
  staffId: string;
  role: StaffRole;
  businessId: string | null;
}

/**
 * Gate an API route to active staff users, optionally restricted by role.
 * Returns a NextResponse (401/403) to send back, or the caller's staff context.
 */
export async function requireStaff(
  request: NextRequest,
  allowedRoles?: StaffRole[],
): Promise<NextResponse | StaffContext> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("id, role, business_id")
    .eq("user_id", userData.user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staff) {
    return NextResponse.json({ error: "Active staff account required" }, { status: 403 });
  }
  if (allowedRoles && !allowedRoles.includes(staff.role as StaffRole)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  return {
    staffId: staff.id as string,
    role: staff.role as StaffRole,
    businessId: (staff.business_id as string | null) ?? null,
  };
}
