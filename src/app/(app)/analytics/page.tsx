import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  BUSINESS_TZ,
  getLocalDateRange,
  monthStartUtc,
  parseLocalYmd,
  todayLocalIso,
} from "@/lib/dates";
import {
  getAnalyticsDailyByTour,
  getAnalyticsSourceTour,
} from "@/lib/dashboard/queries";

import { AnalyticsTabs } from "./analytics-tabs";
import { AnalyticsView } from "./analytics-view";
import { MonthlyComparison, type TourChip } from "./monthly-comparison";

/**
 * Analytics. Where bookings come from (sales source), what each source sells,
 * and how this month's daily volume compares to last month. Everything is
 * aggregated in the database and scoped by RLS (owner = all, manager = their
 * business). Check-in staff do not get analytics.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // Shared with the layout via React cache(): one getUser() + staff lookup.
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/analytics");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/dashboard");

  const supabase = await getSupabaseServerClient();
  const today = todayLocalIso(BUSINESS_TZ);
  const { from: fromParam, to: toParam } = await searchParams;
  const from = parseLocalYmd(fromParam) ?? `${today.slice(0, 7)}-01`;
  const to = parseLocalYmd(toParam) ?? today;

  const startUtc = getLocalDateRange(from, BUSINESS_TZ).startUtc;
  const endUtc = getLocalDateRange(to, BUSINESS_TZ).endUtcExclusive;

  // Default comparison month: the live month.
  const cmpYear = Number(today.slice(0, 4));
  const cmpMonth = Number(today.slice(5, 7));
  const curStart = monthStartUtc(cmpYear, cmpMonth);
  const nextStart = monthStartUtc(
    cmpMonth === 12 ? cmpYear + 1 : cmpYear,
    cmpMonth === 12 ? 1 : cmpMonth + 1,
  );
  const prevStart = monthStartUtc(
    cmpMonth === 1 ? cmpYear - 1 : cmpYear,
    cmpMonth === 1 ? 12 : cmpMonth - 1,
  );

  const [rows, chipRows, cmpCurrent, cmpPrevious] = await Promise.all([
    getAnalyticsSourceTour(supabase, startUtc, endUtc),
    supabase
      .from("business_tours")
      .select("id, name, tour:tours(name, color)")
      .order("name"),
    getAnalyticsDailyByTour(supabase, curStart, nextStart, BUSINESS_TZ),
    getAnalyticsDailyByTour(supabase, prevStart, curStart, BUSINESS_TZ),
  ]);

  type ChipRow = {
    id: string;
    name: string | null;
    tour: { name: string | null; color: string | null } | null;
  };
  const chips: TourChip[] = ((chipRows.data ?? []) as ChipRow[])
    .map((r) => ({
      id: r.id,
      label: r.tour?.name ?? r.name ?? "Untitled tour",
      color: r.tour?.color ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where your bookings come from, and how volume trends month to month.
        </p>
      </header>

      <AnalyticsTabs
        sources={
          <AnalyticsView rows={rows} from={from} to={to} today={today} />
        }
        trends={
          <MonthlyComparison
            chips={chips}
            initialYear={cmpYear}
            initialMonth={cmpMonth}
            initialCurrent={cmpCurrent}
            initialPrevious={cmpPrevious}
            today={today}
          />
        }
      />
    </div>
  );
}
