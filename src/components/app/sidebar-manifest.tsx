"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  BUSINESS_TZ,
  getLocalDateRange,
  parseLocalYmd,
  todayLocalIso,
} from "@/lib/dates";
import { queryKeys } from "@/lib/query/keys";
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

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  month: "short",
  day: "numeric",
});

// Mirrors the bookings list's slot grouping key ("HH:MM" in business time),
// which anchors each time group as id="slot-HHMM" for deep links.
const slotIdFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Departure manifest for check-in staff: each timeslot with the number of
 * guests still to check in (cancelled bookings excluded), and a
 * remaining/total footer. On the Bookings page it follows the selected date
 * (labelled when that is not today); everywhere else it shows today. Data
 * comes from the bookings_checkin_manifest RPC (aggregated in the DB,
 * RLS-scoped to the staffer's assigned tours) and refreshes live as
 * check-ins and bookings change.
 */
export function SidebarManifest({ businessId }: { businessId: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);
  const queryClient = useQueryClient();

  const today = todayLocalIso();
  const date =
    (pathname === "/bookings" && parseLocalYmd(searchParams.get("date"))) ||
    today;

  // Memoised: this is a useEffect dependency, and a fresh array every render
  // would tear down and re-open the Realtime channel on every render.
  const manifestKey = useMemo(() => queryKeys.manifest(date), [date]);

  // The counts are aggregated in the database, so unlike the bookings list
  // there is nothing to patch in place: any change means asking again. What the
  // cache buys here is that a departure's worth of check-ins arriving at once
  // collapses into one in-flight request instead of one per guest.
  const { data: rows } = useQuery({
    queryKey: manifestKey,
    queryFn: async () => {
      const supabase = getSupabaseBrowserClient();
      const range = getLocalDateRange(date);
      const { data, error } = await supabase.rpc("bookings_checkin_manifest", {
        p_start: range.startUtc,
        p_end: range.endUtcExclusive,
      });
      if (error) throw error;
      return (data as ManifestRow[] | null) ?? [];
    },
    staleTime: 0,
  });

  useEffect(() => {
    // Refresh whenever a visible booking changes (check-in, new booking,
    // cancellation). Filtered to this desk's own business, the same way the
    // bookings list does it, so another business's traffic never re-runs the
    // manifest RPC here. RLS is still the boundary; the filter is the saving.
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel("sidebar-manifest")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bookings",
          ...(businessId ? { filter: `business_id=eq.${businessId}` } : {}),
        },
        () => void queryClient.invalidateQueries({ queryKey: manifestKey }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient, manifestKey, businessId]);

  if (!rows) return null; // still loading; keep the sidebar quiet

  const paxTotal = rows.reduce((sum, r) => sum + r.total_pax, 0);
  const checkedTotal = rows.reduce(
    (sum, r) => sum + (r.total_pax - r.remaining_pax),
    0,
  );

  return (
    <div className="flex flex-col gap-1 text-sm">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        aria-expanded={!collapsed}
      >
        <span>
          Manifest
          {date !== today && (
            <span className="ml-1 font-medium normal-case">
              &middot; {dayFormatter.format(new Date(`${date}T12:00:00Z`))}
            </span>
          )}
        </span>
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
                const slotStart = new Date(r.slot_start);
                const anchor = `slot-${slotIdFormatter.format(slotStart).replace(":", "")}`;
                return (
                  <li key={r.slot_start} className="border-b last:border-b-0">
                    <Link
                      href={`/bookings?date=${date}#${anchor}`}
                      className="flex items-center justify-between px-3 py-1.5 transition hover:bg-muted/60"
                    >
                      <span className="text-muted-foreground">
                        {timeFormatter.format(slotStart).toLowerCase()}
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
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          {rows.length > 0 && (
            <div className="flex items-center justify-between px-3 pt-1 text-sm">
              <span className="font-semibold">Totals</span>
              <span
                className="font-semibold tabular-nums"
                title="Checked in / total guests"
              >
                {checkedTotal}/{paxTotal}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
