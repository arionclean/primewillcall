import Link from "next/link";
import { redirect } from "next/navigation";

import { KpiStrip } from "@/components/dashboard/kpi-strip";
import { MonthChart } from "@/components/dashboard/month-chart";
import { OnboardingCta } from "@/components/dashboard/onboarding-cta";
import { TourTallyStrip } from "@/components/dashboard/tour-tally";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BUSINESS_TZ, parseLocalYmd, todayLocalIso } from "@/lib/dates";
import {
  getMonthlyGuests,
  getTodayByTour,
  getTodayKpis,
  getTodayRange,
} from "@/lib/dashboard/queries";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  // Shared with the layout via React cache(): one getUser() + staff lookup.
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login");
  if (!staff || !staff.is_active) {
    return <UnlinkedAccount email={user.email ?? ""} />;
  }

  const supabase = await getSupabaseServerClient();
  const range = getTodayRange();

  // Check-in desk staff work out of the Bookings page (the sidebar Manifest
  // covers their at-a-glance counts), so the dashboard just forwards them.
  if (staff.role === "check_in") {
    redirect("/bookings");
  }

  // Selected month for the chart (?month=YYYY-MM), default to the current month.
  const { month: monthParam } = await searchParams;
  const monthYmd = parseLocalYmd(
    monthParam ? `${monthParam}-01` : null,
  ) ?? `${todayLocalIso(BUSINESS_TZ).slice(0, 7)}-01`;
  const [chartYear, chartMonth] = monthYmd.split("-").map(Number);

  // Bigger fetches in parallel.
  const [kpis, byTour, monthly, businessesProbe, toursProbe] =
    await Promise.all([
      getTodayKpis(supabase, range),
      getTodayByTour(supabase, range),
      getMonthlyGuests(supabase, chartYear, chartMonth, BUSINESS_TZ),
      supabase.from("businesses").select("id", { count: "exact", head: true }),
      supabase.from("tours").select("id", { count: "exact", head: true }),
    ]);

  const businessesCount = businessesProbe.count ?? 0;
  const noBusinesses = businessesCount === 0;
  const noTours = (toursProbe.count ?? 0) === 0;

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Today, {range.localDateLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/schedule"
            className={cn(buttonVariants({ variant: "default" }))}
          >
            + Booking
          </Link>
        </div>
      </header>

      {staff.role === "owner" && (noBusinesses || noTours) && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {noBusinesses && (
            <OnboardingCta
              title="Add your first business"
              description="Prime owns the master account. Add at least one business so we can attach tours and bookings to it."
              ctaLabel="Add business"
              href="/admin/businesses/new"
            />
          )}
          {!noBusinesses && noTours && (
            <OnboardingCta
              title="Add your first tour"
              description="A tour is the scheduled experience a business sells. Set its pax tiers and base price, then bookings can start coming in."
              ctaLabel="Add tour"
              href="/admin/tours/new"
            />
          )}
        </div>
      )}

      <div className="mt-6">
        <KpiStrip kpis={kpis} />
      </div>

      {byTour.length > 0 && (
        <div className="mt-4">
          <TourTallyStrip tallies={byTour} />
        </div>
      )}

      <div className="mt-6">
        <MonthChart data={monthly} />
      </div>

      <p className="mt-10 text-xs text-muted-foreground">
        <Link href="/dashboard/debug" className="underline">
          Account debug info
        </Link>
      </p>
    </div>
  );
}

function UnlinkedAccount({ email }: { email: string }) {
  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <section className="mx-auto w-full max-w-md px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          Account not set up
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          You are signed in as <span className="font-medium">{email}</span>, but
          this account hasn&apos;t been added to the team yet. Ask Prime to add
          you, then sign out and back in.
        </p>
        <form action="/api/auth/signout" method="post" className="mt-6">
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </section>
    </main>
  );
}
