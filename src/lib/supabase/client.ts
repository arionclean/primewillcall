import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

let supabaseClient: SupabaseClient<Database> | null = null;

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

  supabaseClient = createBrowserClient<Database>(url, anonKey);
  return supabaseClient;
}
