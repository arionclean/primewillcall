import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { ScheduleForm, type ScheduleFormTour } from "./form";

export default async function SchedulePage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/schedule");

  const { data: staff } = await supabase
    .from("staff")
    .select("id, full_name, role, business_id, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!staff || !staff.is_active) {
    redirect("/dashboard");
  }

  const role = staff.role;
  const businessId = staff.business_id;

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

  const { data: rows, error } = await query;
  if (error) {
    console.error("[schedule] business_tours fetch error:", error);
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
    .sort((a, b) => {
      const byBiz = a.businessName.localeCompare(b.businessName);
      if (byBiz !== 0) return byBiz;
      return a.name.localeCompare(b.name);
    });

  const emptyCopy =
    role === "owner"
      ? "No tours yet. Add one in Tours."
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
          <ScheduleForm staffId={staff.id} role={role} tours={tours} />
        )}
      </div>
    </div>
  );
}
