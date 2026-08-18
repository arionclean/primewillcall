"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/** One table to watch, optionally narrowed the way Realtime filters are written. */
export type LiveTable = {
  table: string;
  /** e.g. `business_id=eq.<uuid>`. Omit to receive every row RLS allows. */
  filter?: string;
  /** Defaults to every change. Narrow it when only inserts matter. */
  event?: "*" | "INSERT" | "UPDATE" | "DELETE";
};

/**
 * Keep a server-rendered screen live.
 *
 * For screens whose rows are assembled in Postgres (the payments feed and caja
 * both merge two tables, page, and total in an RPC), re-running the server
 * component is the honest way to update: the query stays in one place, the
 * filters and paging stay correct, and there is no second copy of the merge
 * logic in the browser. So this subscribes for the signal and lets
 * `router.refresh()` fetch the answer.
 *
 * The refresh is debounced because a single sale can land as several rows
 * (a charge, then its balance transaction, then a refund), and each would
 * otherwise re-render the page. It also holds off while the tab is hidden and
 * catches up when it comes back, so a kiosk left open on another tab does not
 * refetch all night.
 *
 * RLS scopes the stream, exactly like it scopes the read: a manager is only
 * sent their own business's changes, a check-in account only its own. The
 * `filter` argument is an efficiency, not a security boundary.
 */
export function useLiveRefresh(
  channelName: string,
  tables: LiveTable[],
  { debounceMs = 400 }: { debounceMs?: number } = {},
) {
  const router = useRouter();

  // Serialized so a caller can pass an inline array without resubscribing on
  // every render.
  const key = JSON.stringify(tables);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const watched: LiveTable[] = JSON.parse(key);
    const supabase = getSupabaseBrowserClient();

    const run = () => {
      if (document.hidden) {
        pendingRef.current = true; // catch up on the way back
        return;
      }
      pendingRef.current = false;
      router.refresh();
    };

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, debounceMs);
    };

    const onVisible = () => {
      if (!document.hidden && pendingRef.current) run();
    };
    document.addEventListener("visibilitychange", onVisible);

    let channel = supabase.channel(channelName);
    for (const t of watched) {
      channel = channel.on(
        "postgres_changes",
        {
          event: t.event ?? "*",
          schema: "public",
          table: t.table,
          ...(t.filter ? { filter: t.filter } : {}),
        },
        schedule,
      );
    }
    channel.subscribe((status, err) => {
      // A silently dead subscription is the worst outcome here: the screen
      // looks live and quietly is not. Realtime failures belong in the log,
      // not in front of staff.
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(`[realtime] ${channelName} ${status}`, err ?? "");
      }
    });

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timerRef.current) clearTimeout(timerRef.current);
      void supabase.removeChannel(channel);
    };
  }, [channelName, key, debounceMs, router]);
}
