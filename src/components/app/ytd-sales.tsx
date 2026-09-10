"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { liveChannelName } from "@/lib/realtime/channel-name";

type Ytd = { bookings: number; guests: number };

const KEY = ["bookings-sales-ytd"];

/**
 * Bookings sold so far this year, at the foot of the owner's sidebar.
 *
 * "Sold" is the sale date, not the departure: a booking made today for December
 * counts today. Same basis as the Sales tab on /analytics, which the block links
 * to so the detail is one click away.
 *
 * Cost. The total is one aggregate in the database (bookings_sales_ytd), fetched
 * once after paint, never on the way into a screen, and no booking row reaches
 * the browser. It then stays current WITHOUT asking again: a new booking arrives
 * over Realtime carrying its own row, so the block adds that row's guests to the
 * number it already has. A busy morning costs one query, not one per booking.
 *
 * The query is the correction, not the mechanism: it refetches when the tab is
 * focused again, which is what picks up a booking cancelled after it was
 * counted. Rendered for the owner alone; RLS scopes it regardless.
 */
export function YtdSales() {
  const queryClient = useQueryClient();
  const { data } = useQuery<Ytd>({
    queryKey: KEY,
    queryFn: async () => {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.rpc("bookings_sales_ytd");
      if (error) throw error;
      const row = data?.[0];
      return {
        bookings: Number(row?.bookings ?? 0),
        guests: Number(row?.guests ?? 0),
      };
    },
    staleTime: 300_000,
  });

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(liveChannelName("ytd-sales"))
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "bookings" },
        (payload) => {
          const row = payload.new as {
            status?: string;
            awaiting_payment?: boolean;
            pax_adult?: number;
            pax_child?: number;
            pax_infant?: number;
          };
          // The same two exclusions the aggregate makes: a cancelled booking and
          // an unpaid checkout are not a sale.
          if (row.status === "cancelled" || row.awaiting_payment) return;
          const pax =
            (row.pax_adult ?? 0) + (row.pax_child ?? 0) + (row.pax_infant ?? 0);
          queryClient.setQueryData<Ytd>(KEY, (prev) =>
            prev
              ? { bookings: prev.bookings + 1, guests: prev.guests + pax }
              : prev,
          );
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  if (!data) return null;

  return (
    <Link
      href="/analytics"
      className="mb-4 mt-2 block rounded-lg border bg-muted/30 px-3 py-2.5 transition hover:bg-muted/60"
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Sold this year
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">
        {data.bookings.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground">
        {data.guests.toLocaleString()} guests
      </p>
    </Link>
  );
}
