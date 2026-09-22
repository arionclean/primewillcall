import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import type { SellerTotal } from "./sales-view";

/**
 * What the Sales tab shows for a range: one row per person who took money on a
 * tablet (highest first), the sales nobody can be credited with, and, when asked
 * for, the hours each of them clocked.
 *
 * Both reads are RPCs that sum in Postgres and run as the caller, and both give
 * anyone but the owner no rows.
 */
export async function loadTeamSales(
  supabase: SupabaseClient<Database>,
  {
    startIso,
    endIso,
    business,
    withHours,
  }: { startIso: string; endIso: string; business: string | null; withHours: boolean },
): Promise<{ people: SellerTotal[]; uncredited: SellerTotal | null; showHours: boolean; error: boolean }> {
  const [salesRes, hoursRes] = await Promise.all([
    supabase.rpc("team_sales", {
      p_start: startIso,
      p_end: endIso,
      p_business: business ?? undefined,
    }),
    withHours
      ? supabase.rpc("time_clock_hours", { p_start: startIso, p_end: endIso })
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (salesRes.error) console.error("[sales] totals fetch error:", salesRes.error);
  if (hoursRes.error) console.error("[sales] hours fetch error:", hoursRes.error);

  // Minutes per person. A name changed mid-range gives one person two rows there.
  const hours = new Map<string, { name: string; minutes: number }>();
  for (const h of hoursRes.data ?? []) {
    if (!h.employee_id) continue;
    const prev = hours.get(h.employee_id);
    hours.set(h.employee_id, {
      name: prev?.name ?? h.employee_name,
      minutes: (prev?.minutes ?? 0) + Number(h.minutes ?? 0),
    });
  }

  let uncredited: SellerTotal | null = null;
  const people: SellerTotal[] = [];
  for (const r of salesRes.data ?? []) {
    const employeeId = (r.employee_id as string | null) ?? null;
    const row: SellerTotal = {
      employeeId,
      name: r.employee_name ?? "",
      sales: Number(r.sales ?? 0),
      cashCents: Number(r.cash_cents ?? 0),
      cardCents: Number(r.card_cents ?? 0),
      minutes: employeeId ? (hours.get(employeeId)?.minutes ?? 0) : 0,
    };
    if (employeeId) people.push(row);
    else uncredited = row;
  }

  // Somebody who clocked in and sold nothing is part of the answer too: $0 for
  // the hours they worked. They go after everyone who sold, by name.
  const sold = new Set(people.map((p) => p.employeeId));
  const onlyHours = [...hours.entries()]
    .filter(([id]) => !sold.has(id))
    .map(
      ([id, h]): SellerTotal => ({
        employeeId: id,
        name: h.name,
        sales: 0,
        cashCents: 0,
        cardCents: 0,
        minutes: h.minutes,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    people: [...people, ...onlyHours],
    uncredited,
    showHours: hours.size > 0,
    error: Boolean(salesRes.error),
  };
}
