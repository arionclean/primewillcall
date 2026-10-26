import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { EditBusinessForm } from "./edit-form";
import { StripeAccounts } from "./stripe-accounts";

export default async function EditBusinessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stripe?: string }>;
}) {
  const { id } = await params;
  const { stripe } = await searchParams;
  const supabase = await getSupabaseServerClient();
  const { data: business } = await supabase
    .from("businesses")
    .select(
      "id, name, phone, contact_email, google_review_url, logo_url",
    )
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
        </div>
        <Link
          href="/admin/businesses"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to list
        </Link>
      </header>

      <EditBusinessForm business={business} />

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-semibold">Stripe accounts</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Payments for this business are processed by Stripe. Each account below is
          opened, verified and held by Stripe.
        </p>
        <StripeAccounts businessId={business.id} justReturned={stripe === "return"} />
      </section>
    </div>
  );
}
