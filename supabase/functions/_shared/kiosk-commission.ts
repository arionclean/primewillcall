// Desk commission, per seller, per kiosk, per New York day.
//
// The rule itself (10% of the day's sales once a seller reaches the kiosk's
// starting point, $500 at most desks; kiosk1 pays by $500 milestones from $1,000)
// is the `seller_commissions` database function, the one place it lives.
// This is the single read of it, shared by kiosk-read (the tablet's Commission
// button) and kiosk-closing-report (the close), so the two never disagree.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface SellerCommission {
  employee_id: string;
  name: string;
  sales: number;
  sales_cents: number;
  commission_cents: number;
}

type Row = {
  employee_id: string;
  employee_name: string | null;
  sales: number | string;
  sales_cents: number | string;
  commission_cents: number | string;
};

/** Each seller's sales and commission at one kiosk on one day (YYYY-MM-DD), highest first. */
export async function kioskCommissions(
  sb: SupabaseClient,
  slug: string,
  ymd: string,
): Promise<{ people: SellerCommission[] } | { error: string }> {
  const { data, error } = await sb.rpc("seller_commissions", {
    p_from: ymd,
    p_to: ymd,
    p_kiosk_slug: slug,
  });
  if (error) return { error: error.message };
  return {
    people: ((data ?? []) as Row[]).map((r) => ({
      employee_id: r.employee_id,
      name: r.employee_name ?? "",
      sales: Number(r.sales),
      sales_cents: Number(r.sales_cents),
      commission_cents: Number(r.commission_cents),
    })),
  };
}
