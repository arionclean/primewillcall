import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { EditStaffForm } from "./edit-form";

export default async function EditStaffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();

  const [{ data: staff }, { data: businesses }, { data: tours }, { data: assigned }] =
    await Promise.all([
      supabase
        .from("staff")
        .select("id, full_name, email, role, business_id, is_active")
        .eq("id", id)
        .maybeSingle(),
      supabase.from("businesses").select("id, name").order("name"),
      supabase
        .from("tours")
        .select("id, name")
        .eq("is_active", true)
        .order("name"),
      supabase.from("staff_tours").select("tour_id").eq("staff_id", id),
    ]);

  if (!staff) notFound();

  const assignedTourIds = (assigned ?? []).map((r) => r.tour_id);

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {staff.full_name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{staff.email}</p>
        </div>
        <Link
          href="/admin/staff"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to team
        </Link>
      </header>

      {staff.role === "owner" ? (
        <OwnerLocked />
      ) : (
        <EditStaffForm
          staff={{
            id: staff.id,
            full_name: staff.full_name,
            email: staff.email,
            role: staff.role as "business_manager" | "check_in",
            business_id: staff.business_id,
            is_active: staff.is_active,
          }}
          businesses={businesses ?? []}
          tours={tours ?? []}
          assignedTourIds={assignedTourIds}
        />
      )}
    </div>
  );
}

function OwnerLocked() {
  return (
    <Card>
      <CardContent className="flex items-center gap-2 py-8">
        <Badge tone="primary">Owner</Badge>
        <span className="text-sm font-medium">
          Owner accounts can&apos;t be edited from here.
        </span>
      </CardContent>
    </Card>
  );
}
