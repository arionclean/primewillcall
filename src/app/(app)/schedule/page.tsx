import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAnalyticsSourceTour } from "@/lib/dashboard/queries";

import { ScheduleForm, type ScheduleFormTour } from "./form";

export default async function SchedulePage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/schedule");
  if (!staff || !staff.is_active) {
    redirect("/dashboard");
  }

  const supabase = await getSupabaseServerClient();

  const role = staff.role;
  const businessId = staff.business_id;

  // Owner-editable capability (Team page). RLS enforces it on insert too.
  if (role !== "owner" && !staff.can_create_bookings) {
    redirect("/dashboard");
  }

  // Check-in staff only create bookings for tours assigned to them.
  let assignedTourIds: Set<string> | null = null;
  if (role === "check_in") {
    const { data: assigned } = await supabase
      .from("staff_tours")
      .select("tour_id")
      .eq("staff_id", staff.id);
    assignedTourIds = new Set((assigned ?? []).map((r) => r.tour_id));
  }

  let query = supabase
    .from("business_tours")
    .select(
      `
      id, name, is_active, business_id, tour_id,
      business:businesses!business_tours_business_id_fkey(id, name),
      tour:tours!business_tours_tour_id_fkey(id, name, capacity, is_active, tour_timeslots(start_time, duration_minutes, sort_order)),
      tour_pax_tiers(id, label, description, price_cents, sort_order)
      `,
    )
    .order("name", { ascending: true });

  if (role !== "owner") {
    if (!businessId) {
      // Manager/check-in without a business: nothing to show.
      query = query.eq("business_id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.eq("business_id", businessId);
    }
  }

  // The busiest business comes first in the picker, and within it the busiest
  // product, so the default is what the desk sells most. Volume is bookings 30
  // days back to 30 days ahead, from the same aggregate the analytics page uses.
  // RLS scopes it, so a manager only ever sees their own business.
  const DAY = 24 * 60 * 60 * 1000;
  const [{ data: rows, error }, recent, { data: sourceRows }] = await Promise.all([
    query,
    getAnalyticsSourceTour(
      supabase,
      new Date(Date.now() - 30 * DAY).toISOString(),
      new Date(Date.now() + 30 * DAY).toISOString(),
    ),
    // Where the booking came from: the owner-edited list the form must pick from.
    supabase
      .from("booking_source_options")
      .select("channel")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
  ]);
  const sources = (sourceRows ?? []).map((r) => r.channel);
  if (error) {
    console.error("[schedule] business_tours fetch error:", error);
  }
  const paxByBusiness = new Map<string, number>();
  const paxByTour = new Map<string, number>(); // key: business id + master tour name
  for (const r of recent) {
    paxByBusiness.set(r.businessId, (paxByBusiness.get(r.businessId) ?? 0) + r.pax);
    const k = `${r.businessId}|${r.tour}`;
    paxByTour.set(k, (paxByTour.get(k) ?? 0) + r.pax);
  }

  const tours: ScheduleFormTour[] = (rows ?? [])
    .map((row) => {
      const r = row as unknown as {
        id: string;
        name: string;
        is_active: boolean;
        business_id: string;
        tour_id: string;
        business: { id: string; name: string } | null;
        tour:
          | {
              id: string;
              name: string;
              capacity: number;
              is_active: boolean;
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
          | {
              id: string;
              label: string;
              description: string | null;
              price_cents: number;
              sort_order: number;
            }[]
          | null;
      };

      const slots = (r.tour?.tour_timeslots ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order);
      const tiers = (r.tour_pax_tiers ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order);

      return {
        id: r.id,
        name: r.name,
        businessId: r.business_id,
        businessName: r.business?.name ?? "",
        masterTourId: r.tour?.id ?? r.tour_id,
        masterTourName: r.tour?.name ?? "",
        masterIsActive: r.tour?.is_active ?? false,
        variantIsActive: r.is_active,
        timeslots: slots.map((s) => ({
          start_time: s.start_time,
          duration_minutes: s.duration_minutes,
        })),
        tiers: tiers.map((t) => ({
          id: t.id,
          label: t.label,
          description: t.description,
          price_cents: t.price_cents,
        })),
      };
    })
    .filter((t) => t.masterIsActive && t.variantIsActive)
    .filter((t) => assignedTourIds === null || assignedTourIds.has(t.masterTourId))
    .sort((a, b) => {
      const byVolume =
        (paxByBusiness.get(b.businessId) ?? 0) -
        (paxByBusiness.get(a.businessId) ?? 0);
      if (byVolume !== 0) return byVolume;
      const byBiz = a.businessName.localeCompare(b.businessName);
      if (byBiz !== 0) return byBiz;
      const byTourVolume =
        (paxByTour.get(`${b.businessId}|${b.masterTourName}`) ?? 0) -
        (paxByTour.get(`${a.businessId}|${a.masterTourName}`) ?? 0);
      if (byTourVolume !== 0) return byTourVolume;
      return a.name.localeCompare(b.name);
    });

  const emptyCopy =
    role === "owner"
      ? "No tours yet. Add one in Tours."
      : role === "check_in"
        ? "No tours are assigned to you yet. Ask Prime to assign your tours on the Team page."
        : "No tours available yet. Ask Prime to assign a tour to your business.";

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New booking</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a booking to today&apos;s schedule.
          </p>
        </div>
        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to dashboard
        </Link>
      </header>

      <div className="mt-6">
        {tours.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {emptyCopy}
            </CardContent>
          </Card>
        ) : (
          <ScheduleForm
            staffId={staff.id}
            role={role}
            tours={tours}
            sources={sources}
          />
        )}
      </div>
    </div>
  );
}
