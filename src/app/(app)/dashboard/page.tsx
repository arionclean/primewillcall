import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

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

  // Everything below the header is streamed. The title, the date and the
  // + Booking button need no database at all, so they paint the moment the
  // request lands instead of waiting on the slowest query on the page (the
  // month rollup). Each boundary runs its own queries, and siblings render
  // concurrently, so nothing is serialized by the split.
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

      {staff.role === "owner" && (
        // No fallback: an onboarding prompt that flashes a placeholder before
        // deciding it has nothing to say is worse than arriving a beat late.
        <Suspense fallback={null}>
          <OnboardingChecks />
        </Suspense>
      )}

      <Suspense fallback={<TodaySkeleton />}>
        <TodayPanels range={range} />
      </Suspense>

      <Suspense fallback={<ChartSkeleton />}>
        <MonthPanel year={chartYear} month={chartMonth} />
      </Suspense>
    </div>
  );
}

async function TodayPanels({
  range,
}: {
  range: ReturnType<typeof getTodayRange>;
}) {
  const supabase = await getSupabaseServerClient();
  const [kpis, byTour] = await Promise.all([
    getTodayKpis(supabase, range),
    getTodayByTour(supabase, range),
  ]);

  return (
    <>
      <div className="mt-6">
        <KpiStrip kpis={kpis} />
      </div>
      {byTour.length > 0 && (
        <div className="mt-4">
          <TourTallyStrip tallies={byTour} />
        </div>
      )}
    </>
  );
}

async function MonthPanel({ year, month }: { year: number; month: number }) {
  const supabase = await getSupabaseServerClient();
  const monthly = await getMonthlyGuests(supabase, year, month, BUSINESS_TZ);
  return (
    <div className="mt-6">
      <MonthChart data={monthly} />
    </div>
  );
}

/** Owner-only nudge while the platform is still empty. Two head counts. */
async function OnboardingChecks() {
  const supabase = await getSupabaseServerClient();
  const [businessesProbe, toursProbe] = await Promise.all([
    supabase.from("businesses").select("id", { count: "exact", head: true }),
    supabase.from("tours").select("id", { count: "exact", head: true }),
  ]);

  const noBusinesses = (businessesProbe.count ?? 0) === 0;
  const noTours = (toursProbe.count ?? 0) === 0;
  if (!noBusinesses && !noTours) return null;

  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      {noBusinesses && (
        <OnboardingCta
          title="Add your first business"
          description="Add the first business so its tours and bookings have a home."
          ctaLabel="Add business"
          href="/admin/businesses/new"
        />
      )}
      {!noBusinesses && noTours && (
        <OnboardingCta
          title="Add your first tour"
          description="A tour is what a business sells. Set its departure times and prices, then bookings can start coming in."
          ctaLabel="Add tour"
          href="/admin/tours/new"
        />
      )}
    </div>
  );
}

function TodaySkeleton() {
  return (
    <div className="mt-6 grid animate-pulse gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl border bg-muted/40" />
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="mt-6 h-72 animate-pulse rounded-xl border bg-muted/30" aria-hidden />
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
