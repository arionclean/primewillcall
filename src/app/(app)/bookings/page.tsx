import Link from "next/link";
import { redirect } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  BUSINESS_TZ,
  getLocalDateRange,
  parseLocalYmd,
  todayLocalIso,
} from "@/lib/dates";

import { BookingsList, type BookingRow, type TourOption } from "./list";

const DEFAULT_TIMEZONE = BUSINESS_TZ;

/**
 * Bookings list page. Mirrors the dashboard's today view but lets the operator
 * pick any date and surfaces cancelled rows (dimmed) so they can see the full
 * picture for a given service day.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/bookings");

  const { data: staff } = await supabase
    .from("staff")
    .select("id, role, business_id, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!staff || !staff.is_active) redirect("/dashboard");

  const { date: dateParam } = await searchParams;
  const dateIso = parseLocalYmd(dateParam) ?? todayLocalIso(DEFAULT_TIMEZONE);
  const range = getLocalDateRange(dateIso, DEFAULT_TIMEZONE);

  const { data, error } = await supabase
    .from("bookings")
    .select(
      `
      id,
      starts_at,
      ends_at,
      status,
      total_cents,
      currency,
      business_id,
      business_tour_id,
      customer_id,
      checked_in_at,
      pax_adult,
      pax_child,
      pax_infant,
      notes,
      business_tour:business_tours!bookings_business_tour_id_fkey(
        id,
        name,
        tour:tours(id, name, capacity)
      ),
      customer:customers!bookings_customer_id_fkey(id, full_name, phone, email)
      `,
    )
    .gte("starts_at", range.startUtc)
    .lt("starts_at", range.endUtcExclusive)
    .order("starts_at", { ascending: true });

  if (error) {
    console.error("[bookings] page fetch error:", error);
  }

  const bookings = (data ?? []) as unknown as BookingRow[];

  // Role-scoped tour variants for the filter + edit dropdown. Owner sees all
  // rows; manager and check-in are scoped to their own business.
  let tourQuery = supabase
    .from("business_tours")
    .select(
      `id, name, business_id, is_active,
      business:businesses!business_tours_business_id_fkey(id, name),
      tour:tours!business_tours_tour_id_fkey(id, name, capacity, color, tour_timeslots(start_time, duration_minutes, sort_order)),
      tour_pax_tiers(id, label, price_cents, sort_order)`,
    )
    .order("name", { ascending: true });

  if (staff.role !== "owner") {
    tourQuery = tourQuery.eq(
      "business_id",
      staff.business_id ?? "00000000-0000-0000-0000-000000000000",
    );
  }

  const { data: tourRows, error: tourError } = await tourQuery;
  if (tourError) {
    console.error("[bookings] tour options fetch error:", tourError);
  }

  type TourQueryRow = {
    id: string;
    name: string;
    business_id: string;
    is_active: boolean;
    business: { id: string; name: string } | null;
    tour:
      | {
          id: string;
          name: string;
          capacity: number;
          color: string | null;
          tour_timeslots:
            | {
                start_time: string;
                duration_minutes: number;
                sort_order: number;
              }[]
            | null;
        }
      | null;
    tour_pax_tiers:
      | { id: string; label: string; price_cents: number; sort_order: number }[]
      | null;
  };

  const tourOptions: TourOption[] = ((tourRows ?? []) as unknown as TourQueryRow[])
    .filter((r) => r.is_active !== false)
    .map((r) => ({
      id: r.id,
      name: r.name,
      businessId: r.business_id,
      businessName: r.business?.name ?? "",
      masterTourName: r.tour?.name ?? "",
      capacity: r.tour?.capacity ?? 0,
      color: r.tour?.color ?? null,
      tiers: (r.tour_pax_tiers ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((t) => ({ id: t.id, label: t.label, price_cents: t.price_cents })),
      slots: (r.tour?.tour_timeslots ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((s) => ({
          start_time: s.start_time,
          duration_minutes: s.duration_minutes,
        })),
    }));

  const friendlyLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(range.startUtc));

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Bookings for the selected date. {friendlyLabel}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/schedule"
            className={cn(buttonVariants({ variant: "default" }))}
          >
            + Booking
          </Link>
        </div>
      </header>

      <div className="mt-6">
        <BookingsList
          initial={bookings}
          tours={tourOptions}
          date={dateIso}
          role={staff.role}
          businessId={staff.business_id}
          rangeStartUtc={range.startUtc}
          rangeEndUtcExclusive={range.endUtcExclusive}
        />
      </div>
    </div>
  );
}
