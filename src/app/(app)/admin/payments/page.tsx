import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { PaymentsView } from "./payments-view";

/**
 * Payments ledger for owner + business manager. Supabase-native replacement for
 * the Xano transactions screens (stripe/transactions/list, account/transactions).
 *
 * Reads are RLS-scoped: owner sees every business, a manager sees only their own
 * (check_in has no read policy on the ledger, so they are redirected out). The
 * date-range totals come from the stripe_payments_summary RPC (aggregated in the
 * DB) rather than summing rows in JS, which the 1000-row read cap would truncate.
 */

// Default window: the last 30 days.
const DEFAULT_RANGE_DAYS = 30;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    business?: string;
    q?: string;
  }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/payments");
  if (staff.role === "check_in") redirect("/dashboard");

  const sp = await searchParams;
  const now = new Date();
  const to = sp.to ?? isoDate(now);
  const from =
    sp.from ??
    isoDate(new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000));
  const businessFilter = sp.business && sp.business !== "" ? sp.business : null;
  // Strip PostgREST or() delimiters so the term cannot break the filter string.
  const q = (sp.q ?? "").replace(/[,()]/g, "").trim();

  const startIso = `${from}T00:00:00.000Z`;
  const endIso = `${to}T23:59:59.999Z`;

  const supabase = await getSupabaseServerClient();

  let query = supabase
    .from("stripe_transactions")
    .select(
      "id, stripe_id, business_id, amount, amount_refunded, currency, status, source, card_brand, card_last4, booking_id, booking_ref, customer_email, customer_name, receipt_url, stripe_created, object_type, business:businesses(name)",
    )
    .eq("object_type", "charge")
    .gte("stripe_created", startIso)
    .lte("stripe_created", endIso)
    .order("stripe_created", { ascending: false })
    .limit(200);
  if (businessFilter) query = query.eq("business_id", businessFilter);
  if (q) {
    query = query.or(
      `customer_name.ilike.*${q}*,customer_email.ilike.*${q}*,card_last4.ilike.*${q}*,booking_ref.ilike.*${q}*`,
    );
  }

  const [{ data: transactions }, { data: summaryRows }, businessesResult] =
    await Promise.all([
      query,
      supabase.rpc("stripe_payments_summary", {
        p_start: startIso,
        p_end: endIso,
      }),
      staff.role === "owner"
        ? supabase.from("businesses").select("id, name").order("name")
        : Promise.resolve({ data: null }),
    ]);

  return (
    <PaymentsView
      role={staff.role}
      paymentsConfigured={Boolean(process.env.STRIPE_SECRET_KEY)}
      transactions={transactions ?? []}
      summary={summaryRows?.[0] ?? null}
      businesses={businessesResult.data ?? []}
      filters={{ from, to, business: businessFilter, q }}
    />
  );
}
