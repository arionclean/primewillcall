/**
 * Resolve the calling staff member from the request's Supabase JWT.
 *
 * The functions that use this are deployed with verify_jwt ON, so the platform has
 * already checked the token is valid and unexpired before we run. This adds the part
 * the platform cannot know: which staff row the user is, whether that row is active,
 * and what role it carries. Same shape as getCurrentStaff() in src/lib/auth.ts.
 *
 * The staff row is read with the service role deliberately: the caller is already
 * authenticated, and reading their OWN row must not depend on the staff-select policy.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import { db, SUPABASE_URL } from "./sms.ts";

const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export type StaffRole = "owner" | "business_manager" | "check_in";

export interface Staff {
  id: string;
  role: StaffRole;
  business_id: string | null;
  is_active: boolean;
}

export type StaffAuth =
  | { ok: true; userId: string; staff: Staff }
  | { ok: false; status: number; error: string };

export async function requireStaff(req: Request): Promise<StaffAuth> {
  const authorization = req.headers.get("Authorization");
  if (!authorization) return { ok: false, status: 401, error: "Not authenticated" };

  const scoped = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  });

  const { data: { user } } = await scoped.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not authenticated" };

  const { data: staff } = await db
    .from("staff")
    .select("id, role, business_id, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!staff || !staff.is_active) {
    return { ok: false, status: 403, error: "Active staff account required" };
  }
  return { ok: true, userId: user.id, staff: staff as Staff };
}
