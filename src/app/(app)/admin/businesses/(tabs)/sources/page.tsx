import { getSupabaseServerClient } from "@/lib/supabase/server";

import { SourcesEditor } from "./sources-editor";

/**
 * Booking sources: what the Schedule form offers for where a desk booking came
 * from. Owner-only through the businesses layout gate; every write goes through
 * the server actions next to this page, which re-check the role (RLS backs them).
 */
export default async function BookingSourcesPage() {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("booking_source_options")
    .select("channel, is_active, sort_order")
    .order("sort_order", { ascending: true });

  if (error) console.error("[sources] fetch error:", error);

  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        The choices staff pick from under &quot;Source&quot; when they add a booking.
        Hide one to keep it out of that list; the bookings that used it keep it.
      </p>

      {error ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Could not load the sources. Refresh the page and try again.
        </p>
      ) : null}

      <SourcesEditor rows={data ?? []} />
    </div>
  );
}
