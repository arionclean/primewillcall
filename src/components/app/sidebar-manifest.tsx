"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { BUSINESS_TZ, getLocalDateRange, todayLocalIso } from "@/lib/dates";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type ManifestRow = {
  slot_start: string;
  remaining_pax: number;
  total_pax: number;
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * Today's departure manifest for check-in staff: each timeslot with the
 * number of guests still to check in (cancelled bookings excluded), and a
 * remaining/total footer. Data comes from the bookings_checkin_manifest RPC
 * (aggregated in the DB, RLS-scoped to the staffer's assigned tours) and
 * refreshes live as check-ins and bookings change.
 */
export function SidebarManifest() {
  const [rows, setRows] = useState<ManifestRow[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const range = getLocalDateRange(todayLocalIso());
    const { data, error } = await supabase.rpc("bookings_checkin_manifest", {
      p_start: range.startUtc,
      p_end: range.endUtcExclusive,
    });
    if (!error) setRows((data as ManifestRow[] | null) ?? []);
  }, []);

  useEffect(() => {
    void load();

    // Refresh whenever any visible booking changes (check-in, new booking,
    // cancellation). RLS already limits the subscription to rows we can see.
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel("sidebar-manifest")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bookings" },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  if (rows === null) return null; // still loading; keep the sidebar quiet

  const remainingTotal = rows.reduce((sum, r) => sum + r.remaining_pax, 0);
  const paxTotal = rows.reduce((sum, r) => sum + r.total_pax, 0);

  return (
    <div className="flex flex-col gap-1 text-sm">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        aria-expanded={!collapsed}
      >
        Manifest
        <ChevronDown
          aria-hidden
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            collapsed ? "-rotate-90" : "",
          )}
        />
      </button>

      {!collapsed && (
        <>
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No departures today.
            </p>
          ) : (
            <ul className="overflow-hidden rounded-md border">
              {rows.map((r) => {
                const done = r.remaining_pax === 0;
                return (
                  <li
                    key={r.slot_start}
                    className="flex items-center justify-between border-b px-3 py-1.5 last:border-b-0"
                  >
                    <span className="text-muted-foreground">
                      {timeFormatter.format(new Date(r.slot_start)).toLowerCase()}
                    </span>
                    {done ? (
                      <span className="text-xs font-medium text-emerald-600">
                        completed
                      </span>
                    ) : (
                      <span className="font-medium tabular-nums">
                        {r.remaining_pax}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {rows.length > 0 && (
            <div className="flex items-center justify-between px-3 pt-1 text-sm">
              <span className="font-semibold">Totals</span>
              <span className="font-semibold tabular-nums">
                {remainingTotal}/{paxTotal}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
