import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import type { SellerTotal } from "./sales-view";

/**
 * What the Sales tab shows for a range: one row per person who took money on a
 * tablet (highest first), the sales nobody can be credited with, each person's
 * desk commission, and, when asked for, the hours each of them clocked.
 *
 * Every read is an RPC that sums in Postgres and runs as the caller, and each
 * gives anyone but the owner no rows.
 */
export async function loadTeamSales(
  supabase: SupabaseClient<Database>,
  {
    from,
    to,
    startIso,
    endIso,
    business,
    withHours,
  }: {
    /** The range as New York days, for the commission, which is earned per day. */
    from: string;
    to: string;
    startIso: string;
    endIso: string;
    business: string | null;
    withHours: boolean;
  },
): Promise<{ people: SellerTotal[]; uncredited: SellerTotal | null; showHours: boolean; error: boolean }> {
  const [salesRes, hoursRes, commissionRes] = await Promise.all([
    supabase.rpc("team_sales", {
      p_start: startIso,
      p_end: endIso,
      p_business: business ?? undefined,
    }),
    withHours
      ? supabase.rpc("time_clock_hours", { p_start: startIso, p_end: endIso })
      : Promise.resolve({ data: null, error: null }),
    supabase.rpc("team_commissions", {
      p_from: from,
      p_to: to,
      p_business: business ?? undefined,
    }),
  ]);
  if (salesRes.error) console.error("[sales] totals fetch error:", salesRes.error);
  if (hoursRes.error) console.error("[sales] hours fetch error:", hoursRes.error);
  if (commissionRes.error) console.error("[sales] commission fetch error:", commissionRes.error);

  // Commission per person: the sum of every day they reached the mark at a kiosk.
  const commission = new Map<string, { name: string; cents: number }>();
  for (const c of commissionRes.data ?? []) {
    if (!c.employee_id) continue;
    commission.set(c.employee_id, {
      name: c.employee_name ?? "",
      cents: Number(c.commission_cents ?? 0),
    });
  }

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
      commissionCents: employeeId ? (commission.get(employeeId)?.cents ?? 0) : 0,
      minutes: employeeId ? (hours.get(employeeId)?.minutes ?? 0) : 0,
    };
    if (employeeId) people.push(row);
    else uncredited = row;
  }

  // Somebody who clocked in and sold nothing is part of the answer too: $0 for
  // the hours they worked. So is a commission the ledger above credits to nobody
  // (the commission reads the kiosk's own sales). They go after everyone who
  // sold, by name.
  const sold = new Set(people.map((p) => p.employeeId));
  const others = new Map<string, string>();
  for (const [id, h] of hours) if (!sold.has(id)) others.set(id, h.name);
  for (const [id, c] of commission) if (!sold.has(id) && !others.has(id)) others.set(id, c.name);
  const unsold = [...others.entries()]
    .map(
      ([id, name]): SellerTotal => ({
        employeeId: id,
        name,
        sales: 0,
        cashCents: 0,
        cardCents: 0,
        commissionCents: commission.get(id)?.cents ?? 0,
        minutes: hours.get(id)?.minutes ?? 0,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    people: [...people, ...unsold],
    uncredited,
    showHours: hours.size > 0,
    error: Boolean(salesRes.error || commissionRes.error),
  };
}
