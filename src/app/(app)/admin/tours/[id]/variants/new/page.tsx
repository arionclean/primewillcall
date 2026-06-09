import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { NewVariantForm } from "./form";

export default async function NewVariantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();

  const [{ data: tour }, { data: businesses }, { data: existing }] =
    await Promise.all([
      supabase.from("tours").select("id, name").eq("id", id).maybeSingle(),
      supabase.from("businesses").select("id, name").order("name"),
      supabase
        .from("business_tours")
        .select("business_id")
        .eq("tour_id", id),
    ]);

  if (!tour) notFound();

  const taken = new Set((existing ?? []).map((r) => r.business_id));
  const remaining = (businesses ?? []).filter((b) => !taken.has(b.id));

  if (remaining.length === 0) {
    return (
      <div>
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Add variant
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            For master tour: {tour.name}
          </p>
        </header>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Every business already has a variant of this tour, or no
              businesses exist yet.
            </p>
            <Link
              href={`/admin/tours/${id}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Back to tour
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add variant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For master tour:{" "}
          <span className="font-medium text-foreground">{tour.name}</span>
        </p>
      </header>
      <NewVariantForm
        tourId={tour.id}
        tourName={tour.name}
        businesses={remaining}
      />
    </div>
  );
}
