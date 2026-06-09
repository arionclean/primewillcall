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
    .select("id, full_name, role, business_id, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  return { user, staff };
});
