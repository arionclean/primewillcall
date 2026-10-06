import { redirect } from "next/navigation";

import { getCurrentStaff, staffCapabilities } from "@/lib/auth";
import { nyDateISO, shiftDayISO } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { CashCloseView, type CloseRow } from "./cash-view";

/**
 * Cash close: the end-of-night count against the system, one row per kiosk per
 * business day. This is the answer to "is the money we collected the money the
 * system says we took", and the only screen that shows the commission staff type
 * at the desk, which is money that leaves the till before it reaches the office.
 *
 * The range defaults to the last seven days: unlike the sales ledger, one night
 * on its own says nothing about whether the counts are drifting.
 *
 * Everything is aggregated by the kiosk_cash_reconciliation RPC: a month of kiosk
 * cash is thousands of rows, well past the 1000-row read cap, and the comparison
 * is a SUM either way. The RPC is SECURITY INVOKER, so the owner sees every
 * kiosk and a manager only their own business's nights.
 */

export default async function CashClosePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; business?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/payments/cash");
  if (staff.role === "check_in") redirect("/dashboard");
  if (!staffCapabilities(staff).canViewPayments) redirect("/dashboard");

  const sp = await searchParams;
  const to = sp.to ?? nyDateISO();
  const from = sp.from ?? shiftDayISO(to, -6);
  const businessFilter = sp.business && sp.business !== "" ? sp.business : null;

  const supabase = await getSupabaseServerClient();

  const [{ data: rows }, businessesResult] = await Promise.all([
    supabase.rpc("kiosk_cash_reconciliation", {
      p_from: from,
      p_to: to,
      p_business: businessFilter ?? undefined,
    }),
    staff.role === "owner"
      ? supabase.from("businesses").select("id, name").order("name")
      : Promise.resolve({ data: null }),
  ]);

  const nights: CloseRow[] = (rows ?? []).map((r) => ({
    closing_id: r.closing_id,
    business_date: r.business_date,
    kiosk_id: r.kiosk_id,
    kiosk_slug: r.kiosk_slug,
    business_id: r.business_id,
    business_name: r.business_name,
    closed: r.closed,
    entered_manually: r.entered_manually,
    closed_by_name: r.closed_by_name,
    closed_at: r.closed_at,
    counted_cash_cents: r.counted_cash_cents,
    counted_cash_cents_corrected: r.counted_cash_cents_corrected,
    effective_counted_cash_cents: r.effective_counted_cash_cents,
    system_cash_cents: r.system_cash_cents,
    system_cash_count: r.system_cash_count,
    system_card_cents: r.system_card_cents,
    system_card_gross_cents: r.system_card_gross_cents,
    system_card_count: r.system_card_count,
    reported_card_cents: r.reported_card_cents,
    after_close_count: r.after_close_count,
    after_close_cents: r.after_close_cents,
    commission_cents: r.commission_cents,
    commission_cents_corrected: r.commission_cents_corrected,
    effective_commission_cents: r.effective_commission_cents,
    correction_note: r.correction_note,
    reviewed_at: r.reviewed_at,
    reviewed_by_name: r.reviewed_by_name,
    to_collect_cents: r.to_collect_cents,
    diff_cents: r.diff_cents,
  }));

  return (
    <CashCloseView
      isOwner={staff.role === "owner"}
      nights={nights}
      businesses={businessesResult.data ?? []}
      filters={{ from, to, business: businessFilter ?? "" }}
    />
  );
}
