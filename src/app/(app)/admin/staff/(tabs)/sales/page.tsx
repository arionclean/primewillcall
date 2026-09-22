import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { nyDateISO, nyLocalToUtcIso, shiftDayISO } from "@/lib/dashboard/queries";
import { parseLocalYmd } from "@/lib/dates";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { weekStartISO } from "../hours-range";
import { loadTeamSales } from "../sales";
import { SalesView } from "../sales-view";

/**
 * Sales: the money each person who types a PIN took on the tablets.
 *
 * Owner only: the tab, this page and the team_sales function all say so (the
 * function returns no rows for anyone else), so a manager who guesses the URL
 * gets the People tab, not somebody's sales.
 *
 * The totals come from the team_sales RPC, summed in Postgres from the Payments
 * ledger, so a person's cash and card here add up to what Payments shows for
 * the tablets. A sale counts for the PIN typed when it was made; sales without
 * one come back as a single row, so the Total is every tablet sale in the range.
 *
 * Hours and Per hour come from the time clock. The clock is not kept per
 * business, so a business filter hides them rather than divide one business's
 * sales by every hour worked.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; business?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/staff/sales");
  if (staff.role !== "owner") redirect("/admin/staff/people");

  const sp = await searchParams;
  const today = nyDateISO();
  // Opens on this week so far: the payroll week, Monday first, as on Hours.
  const from = parseLocalYmd(sp.from) ?? weekStartISO(today);
  const to = parseLocalYmd(sp.to) ?? today;
  const business = sp.business && UUID_RE.test(sp.business) ? sp.business : null;

  const supabase = await getSupabaseServerClient();
  const [sales, businessesRes] = await Promise.all([
    loadTeamSales(supabase, {
      // Business-time day bounds, end exclusive: the window both RPCs sum over.
      startIso: nyLocalToUtcIso(from, "00:00"),
      endIso: nyLocalToUtcIso(shiftDayISO(to, 1), "00:00"),
      business,
      withHours: !business,
    }),
    supabase.from("businesses").select("id, name").order("name"),
  ]);

  return (
    <SalesView
      people={sales.people}
      uncredited={sales.uncredited}
      showHours={sales.showHours}
      businesses={businessesRes.data ?? []}
      filters={{ from, to, business: business ?? "" }}
      loadError={sales.error}
    />
  );
}
