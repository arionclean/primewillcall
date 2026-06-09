import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function ToursListPage() {
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
    return <ManagerToursList businessId={current.business_id} />;
  }

  return <OwnerToursList />;
}

async function OwnerToursList() {
  const supabase = await getSupabaseServerClient();
  const { data: tours, error } = await supabase
    .from("tours")
    .select(
      `id, name, capacity, is_active,
       tour_timeslots(id),
       business_tours(id)`,
    )
    .order("name", { ascending: true });

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tours</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Master tours Prime owns. Each business can attach its own variant
            with a custom name and prices, but the capacity and timeslots are
            shared.
          </p>
        </div>
        <Link
          href="/admin/tours/new"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          + Add tour
        </Link>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error.message}
        </p>
      )}

      {(!tours || tours.length === 0) ? (
        <OwnerEmptyState />
      ) : (
        <ul className="space-y-2">
          {tours.map((t) => (
            <li key={t.id}>
              <Link
                href={`/admin/tours/${t.id}`}
                className="block transition hover:translate-x-0.5"
              >
                <Card>
                  <CardContent className="flex items-center gap-4 py-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                      {t.capacity}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Capacity {t.capacity} ·{" "}
                        {t.tour_timeslots?.length ?? 0} timeslot
                        {(t.tour_timeslots?.length ?? 0) === 1 ? "" : "s"} ·{" "}
                        {t.business_tours?.length ?? 0} business variant
                        {(t.business_tours?.length ?? 0) === 1 ? "" : "s"}
                        {!t.is_active && " · inactive"}
                      </p>
                    </div>
                    <span aria-hidden className="text-muted-foreground">
                      ›
                    </span>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OwnerEmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">No tours yet.</p>
        <Link
          href="/admin/tours/new"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          + Add your first tour
        </Link>
      </CardContent>
    </Card>
  );
}

async function ManagerToursList({ businessId }: { businessId: string }) {
  const supabase = await getSupabaseServerClient();
  const { data: rows, error } = await supabase
    .from("business_tours")
    .select(
      `id, name, is_active, tour_id,
       tours!inner(id, name, capacity, is_active),
       tour_pax_tiers(id)`,
    )
    .eq("business_id", businessId)
    .order("name", { ascending: true });

  type Row = {
    id: string;
    name: string;
    is_active: boolean;
    tour_id: string;
    tours: { id: string; name: string; capacity: number; is_active: boolean } | null;
    tour_pax_tiers: { id: string }[] | null;
  };
  const list = (rows ?? []) as unknown as Row[];

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tours</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tours available to your team.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error.message}
        </p>
      )}

      {list.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No tours yet. Ask Prime to assign one to your business.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {list.map((row) => {
            const capacity = row.tours?.capacity ?? 0;
            const tierCount = row.tour_pax_tiers?.length ?? 0;
            return (
              <li key={row.id}>
                <Link
                  href={`/admin/tours/${row.tour_id}`}
                  className="block transition hover:translate-x-0.5"
                >
                  <Card>
                    <CardContent className="flex items-center gap-4 py-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                        {capacity}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{row.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Capacity {capacity} · {tierCount} price tier
                          {tierCount === 1 ? "" : "s"}
                          {!row.is_active && " · inactive"}
                        </p>
                      </div>
                      <span aria-hidden className="text-muted-foreground">
                        ›
                      </span>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
