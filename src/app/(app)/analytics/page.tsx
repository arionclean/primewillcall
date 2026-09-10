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
  getAnalyticsKioskSourceTour,
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
  // Default to a single day, today. The desk question is "how did today go";
  // the presets and the Custom range cover anything wider.
  const from = parseLocalYmd(fromParam) ?? today;
  const to = parseLocalYmd(toParam) ?? from;

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

  // Both tabs are fetched together and both stay mounted, the way the existing
  // tabs already work, so switching between Departures and Sales is instant and
  // each keeps its own selections. Four small aggregated reads, all in parallel.
  const [
    rows,
    kioskRows,
    saleRows,
    saleKioskRows,
    chipRows,
    cmpCurrent,
    cmpPrevious,
  ] = await Promise.all([
    getAnalyticsSourceTour(supabase, startUtc, endUtc, "departure"),
    getAnalyticsKioskSourceTour(supabase, startUtc, endUtc, "departure"),
    getAnalyticsSourceTour(supabase, startUtc, endUtc, "sale"),
    getAnalyticsKioskSourceTour(supabase, startUtc, endUtc, "sale"),
    supabase
      .from("business_tours")
      // analytics_label is the database computed column: the tour's /analytics
      // display name (tour_analytics_labels, else its own name), so a chip reads
      // the same words the RPCs return.
      .select("id, name, tour:tours(name, color, analytics_label)")
      .order("name"),
    getAnalyticsDailyByTour(supabase, curStart, nextStart, BUSINESS_TZ),
    getAnalyticsDailyByTour(supabase, prevStart, curStart, BUSINESS_TZ),
  ]);

  type ChipRow = {
    id: string;
    name: string | null;
    tour: {
      name: string | null;
      color: string | null;
      analytics_label: string | null;
    } | null;
  };
  // One chip per product NAME, not per business_tours row. Each business keeps
  // its own copy of a tour, so "Everglades Tour" was three rows and the chip
  // list repeated it three times. The chip carries every id behind the name.
  const byLabel = new Map<string, TourChip>();
  for (const r of (chipRows.data ?? []) as ChipRow[]) {
    const label =
      r.tour?.analytics_label ?? r.tour?.name ?? r.name ?? "Untitled tour";
    const existing = byLabel.get(label);
    if (existing) {
      existing.ids.push(r.id);
      existing.color ??= r.tour?.color ?? null;
    } else {
      byLabel.set(label, {
        id: label,
        label,
        color: r.tour?.color ?? null,
        ids: [r.id],
      });
    }
  }
  const chips: TourChip[] = Array.from(byLabel.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
      </header>

      <AnalyticsTabs
        departures={
          <AnalyticsView
            rows={rows}
            kioskRows={kioskRows}
            from={from}
            to={to}
            today={today}
            basis="departure"
          />
        }
        sales={
          <AnalyticsView
            rows={saleRows}
            kioskRows={saleKioskRows}
            from={from}
            to={to}
            today={today}
            basis="sale"
          />
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
