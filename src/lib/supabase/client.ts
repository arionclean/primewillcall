import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

let supabaseClient: SupabaseClient<Database> | null = null;

/**
 * On a shared login, the employee who unlocked the screen is in a plain cookie
 * (set by lib/employee-session.ts, which cannot be imported here: it is server
 * code). Their id goes out as a header on every request so the activity-log
 * trigger can stamp them on a direct edit, the same as on a server action. The
 * client is created once, so the PIN screen reloads the page after an unlock or a
 * lock rather than trying to swap headers on a live client.
 */
function employeeHeader(): Record<string, string> | undefined {
  if (typeof document === "undefined") return undefined;
  const m = document.cookie.match(/(?:^|;\s*)pwc_employee_id=([0-9a-f-]{36})(?:;|$)/i);
  return m ? { "x-employee-id": m[1] } : undefined;
}

/**
 * Browser-side Supabase client (cookie-based session, SSR-aware).
 * Cached so a single instance is reused across the app.
 */
export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  const headers = employeeHeader();
  supabaseClient = createBrowserClient<Database>(url, anonKey, headers ? { global: { headers } } : undefined);
  return supabaseClient;
}
