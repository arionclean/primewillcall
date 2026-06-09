import { getSupabaseServerClient } from "@/lib/supabase/server";

import { NewStaffForm } from "./form";

export default async function NewStaffPage() {
  const supabase = await getSupabaseServerClient();
  const [{ data: businesses }, { data: tours }] = await Promise.all([
    supabase.from("businesses").select("id, name").order("name"),
    supabase
      .from("tours")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Add team member
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          They&apos;ll get an email invite to set their password and sign in.
        </p>
      </header>
      <NewStaffForm
        businesses={businesses ?? []}
        tours={tours ?? []}
      />
    </div>
  );
}
