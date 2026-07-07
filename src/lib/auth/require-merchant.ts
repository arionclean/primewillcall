import { NextRequest, NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Gate an API route to authenticated merchant users.
 * Returns a NextResponse (401/403) to send back, or the caller's user id.
 */
export async function requireMerchant(
  request: NextRequest,
): Promise<NextResponse | { userId: string }> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const { data: appUser } = await supabase
    .from("app_users")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (appUser?.role !== "merchant") {
    return NextResponse.json({ error: "Merchant role required" }, { status: 403 });
  }

  return { userId: userData.user.id };
}
