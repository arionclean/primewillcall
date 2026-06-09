import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Service-role Supabase client. Bypasses RLS entirely, so only use it for
 * privileged operations on the server (admin invites, cross-org backfills,
 * etc.). Returns null if SUPABASE_SERVICE_ROLE_KEY is not configured, so
 * callers can gracefully fall back to a non-invite flow.
 *
 * NEVER expose this client to the browser.
 */
export function getSupabaseAdminClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
