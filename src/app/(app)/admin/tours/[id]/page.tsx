import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { EditTourForm } from "./edit-form";
import { ManagerEditTourForm } from "./manager-edit-form";

export default async function EditTourPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: current } = user
    ? await supabase
        .from("staff")
        .select("role, business_id")
        .eq("user_id", user.id)
        .maybeSingle()
    : { data: null };

  if (current?.role === "business_manager" && current.business_id) {
    return (
      <ManagerEditTourView tourId={id} businessId={current.business_id} />
    );
  }

  return <OwnerEditTourView tourId={id} />;
}

async function OwnerEditTourView({ tourId }: { tourId: string }) {
  const supabase = await getSupabaseServerClient();

  const [
    { data: tour },
    { data: timeslots },
    { data: businesses },
    { data: assigned },
  ] = await Promise.all([
    supabase
      .from("tours")
      .select(
        "id, name, capacity, is_active, instructions, meeting_point_address, meeting_point_lat, meeting_point_lng",
      )
      .eq("id", tourId)
      .maybeSingle(),
    supabase
      .from("tour_timeslots")
      .select("id, start_time, duration_minutes, sort_order")
      .eq("tour_id", tourId)
      .order("sort_order", { ascending: true }),
    supabase.from("businesses").select("id, name").order("name"),
    supabase
      .from("business_tours")
      .select("business_id")
      .eq("tour_id", tourId),
  ]);

  if (!tour) notFound();

  const assignedBusinessIds = (assigned ?? []).map((r) => r.business_id);

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {tour.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Master tour. Capacity and timeslots are shared with every business.
          </p>
        </div>
        <Link
          href="/admin/tours"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to list
        </Link>
      </header>

      <EditTourForm
        tour={tour}
        timeslots={timeslots ?? []}
        businesses={businesses ?? []}
        assignedBusinessIds={assignedBusinessIds}
      />
    </div>
  );
}

async function ManagerEditTourView({
  tourId,
  businessId,
}: {
  tourId: string;
  businessId: string;
}) {
  const supabase = await getSupabaseServerClient();

  const { data: businessTour } = await supabase
    .from("business_tours")
    .select("id, name, is_active")
    .eq("tour_id", tourId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (!businessTour) notFound();

  const [{ data: tour }, { data: timeslots }, { data: tiers }] =
    await Promise.all([
      supabase
        .from("tours")
        .select("name, capacity, instructions, meeting_point_address")
        .eq("id", tourId)
        .maybeSingle(),
      supabase
        .from("tour_timeslots")
        .select("start_time, duration_minutes, sort_order")
        .eq("tour_id", tourId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("tour_pax_tiers")
        .select("id, label, description, price_cents, sort_order")
        .eq("business_tour_id", businessTour.id)
        .order("sort_order", { ascending: true }),
    ]);

  if (!tour) notFound();

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {businessTour.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Update the name and prices for this tour.
          </p>
        </div>
        <Link
          href="/admin/tours"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to list
        </Link>
      </header>

      <ManagerEditTourForm
        businessTour={businessTour}
        tourId={tourId}
        tour={tour}
        timeslots={timeslots ?? []}
        tiers={tiers ?? []}
      />
    </div>
  );
}
