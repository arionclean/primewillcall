import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { platformFeeBps } from "@/lib/stripe/server";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { EditBusinessForm } from "./edit-form";
import { StripeConnectPanel } from "./stripe-connect-panel";

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
      "id, name, phone, contact_email, google_review_url, logo_url, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, stripe_requirements_due",
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

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-semibold">Payments</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Connect this business to Stripe so it can accept payments and receive
          payouts. Charges settle on the business&apos;s account with Prime&apos;s
          platform fee.
        </p>
        <Card>
          <CardContent className="py-6">
            <StripeConnectPanel
              business={business}
              paymentsConfigured={Boolean(process.env.STRIPE_SECRET_KEY)}
              feeBps={platformFeeBps()}
              justReturned={stripe === "return"}
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
