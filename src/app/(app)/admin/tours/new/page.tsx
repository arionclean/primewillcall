import { getSupabaseServerClient } from "@/lib/supabase/server";

import { NewTourForm } from "./form";
import { InfoTip } from "@/components/ui/info-tip";

export default async function NewTourPage() {
  const supabase = await getSupabaseServerClient();
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name")
    .order("name", { ascending: true });

  return (
    <div>
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Add tour</h1>
          <InfoTip text="Set the capacity and the departure times, then pick which businesses sell it. Each business gets its own name and prices, which you can edit after saving." />
        </div>
      </header>
      <NewTourForm businesses={businesses ?? []} />
    </div>
  );
}
