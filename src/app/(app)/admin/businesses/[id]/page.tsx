import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { EditBusinessForm } from "./edit-form";

export default async function EditBusinessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  const { data: business } = await supabase
    .from("businesses")
    .select("id, name, phone, logo_url")
    .eq("id", id)
    .maybeSingle();

  if (!business) notFound();

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {business.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Edit business details.
          </p>
        </div>
        <Link
          href="/admin/businesses"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to list
        </Link>
      </header>
      <EditBusinessForm business={business} />
    </div>
  );
}
