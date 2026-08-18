"use client";

import { useQuery } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Outstanding OTA emails waiting for an owner to match them.
 *
 * This used to be counted in the (app) layout, which meant every navigation
 * blocked on it: roughly 150ms added to every screen an owner opened, for a
 * number on a sidebar link. It is now fetched after paint, so it costs nothing
 * on the way in, and it refreshes on its own instead of only when the layout
 * happens to re-render.
 *
 * A head-only COUNT, so the rows never leave the database. RLS already limits
 * this table to the owner; the component simply is not rendered for anyone else.
 */
export function UnmatchedBadge() {
  const { data: count = 0 } = useQuery({
    queryKey: ["unmatched-count"],
    queryFn: async () => {
      const supabase = getSupabaseBrowserClient();
      const { count, error } = await supabase
        .from("email_match_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "urgent");
      if (error) throw error;
      return count ?? 0;
    },
    // A work queue, not live data. One minute is plenty, and it keeps a long
    // session from counting on every navigation.
    staleTime: 60_000,
  });

  if (count <= 0) return null;

  return (
    <span
      // Outstanding work, so it reads as "needs you", not decoration.
      className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-red-600 tabular-nums dark:bg-red-950/50 dark:text-red-400"
      aria-label={`${count.toLocaleString()} need review`}
    >
      {count > 999 ? "999+" : count.toLocaleString()}
    </span>
  );
}
