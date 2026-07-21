import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { nyDateISO, nyLocalToUtcIso, shiftDayISO } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { PaymentsView, type FeedItem } from "./payments-view";

/**
 * Payments ledger for owner + business manager. Supabase-native replacement for
 * the Xano transactions screens (stripe/transactions/list, account/transactions).
 *
 * The feed merges two RLS-scoped sources: card charges from stripe_transactions
 * (webhook-fed) and kiosk cash sales from cash_sales (type='cash' only; its
 * 'card' rows mirror Stripe charges and would double count). Owner sees every
 * business, a manager only their own; check_in is redirected out. Totals come
 * from the payments_summary RPC (card + cash aggregated in the DB) rather than
 * summing rows in JS, which the 1000-row read cap would truncate.
 */

// Default window: the last 30 days, in business time (America/New_York) so the
// server default matches the client's range presets.
const DEFAULT_RANGE_DAYS = 30;

// Source filter values are kiosk slugs (from the kiosks table) plus the
// static channels; accept anything slug-shaped, the queries are parameterized.
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/i;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    business?: string;
    q?: string;
    source?: string;
  }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/payments");
  if (staff.role === "check_in") redirect("/dashboard");

  const sp = await searchParams;
  const to = sp.to ?? nyDateISO();
  const from = sp.from ?? shiftDayISO(to, -(DEFAULT_RANGE_DAYS - 1));
  const businessFilter = sp.business && sp.business !== "" ? sp.business : null;
  const sourceFilter =
    sp.source && SOURCE_RE.test(sp.source) ? sp.source : null;
  // Strip PostgREST or() delimiters so the term cannot break the filter string.
  const q = (sp.q ?? "").replace(/[,()]/g, "").trim();

  // Day bounds in business time: "today" means the New York day, matching how
  // the rows are displayed. End bound is the last ms before the next NY day.
  const startIso = nyLocalToUtcIso(from, "00:00");
  const endIso = new Date(
    new Date(nyLocalToUtcIso(shiftDayISO(to, 1), "00:00")).getTime() - 1,
  ).toISOString();

  const supabase = await getSupabaseServerClient();

  let cardQuery = supabase
    .from("stripe_transactions")
    .select(
      "id, stripe_id, business_id, amount, amount_refunded, currency, status, source, card_brand, card_last4, booking_id, booking_ref, customer_email, customer_name, receipt_url, stripe_created, object_type, business:businesses(name)",
    )
    .eq("object_type", "charge")
    .gte("stripe_created", startIso)
    .lte("stripe_created", endIso)
    .order("stripe_created", { ascending: false })
    .limit(200);
  if (businessFilter) cardQuery = cardQuery.eq("business_id", businessFilter);
  if (sourceFilter) cardQuery = cardQuery.eq("source", sourceFilter);
  if (q) {
    cardQuery = cardQuery.or(
      `customer_name.ilike.*${q}*,customer_email.ilike.*${q}*,card_last4.ilike.*${q}*,booking_ref.ilike.*${q}*`,
    );
  }

  let cashQuery = supabase
    .from("cash_sales")
    .select(
      "id, business_id, booking_ref, amount_cents, kiosk_slug, created_at, business:businesses(name)",
    )
    .eq("type", "cash")
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: false })
    .limit(200);
  if (businessFilter) cashQuery = cashQuery.eq("business_id", businessFilter);
  if (sourceFilter) cashQuery = cashQuery.eq("kiosk_slug", sourceFilter);
  if (q) cashQuery = cashQuery.ilike("booking_ref", `%${q}%`);

  const [
    { data: cardRows },
    { data: cashRows },
    { data: summaryRows },
    { data: kioskRows },
    businessesResult,
  ] = await Promise.all([
    cardQuery,
    cashQuery,
    supabase.rpc("payments_summary", {
      p_start: startIso,
      p_end: endIso,
      ...(businessFilter ? { p_business: businessFilter } : {}),
      ...(sourceFilter ? { p_source: sourceFilter } : {}),
    }),
    // Only selling kiosks appear in the Source filter: reader tablets
    // (can_create_bookings=false) never produce sales.
    supabase
      .from("kiosks")
      .select("slug")
      .eq("status", "active")
      .eq("can_create_bookings", true)
      .not("slug", "is", null)
      .order("slug"),
    staff.role === "owner"
      ? supabase.from("businesses").select("id, name").order("name")
      : Promise.resolve({ data: null }),
  ]);

  const items: FeedItem[] = [
    ...(cardRows ?? []).map((t) => ({ kind: "card" as const, ...t })),
    ...(cashRows ?? []).map((c) => ({ kind: "cash" as const, ...c })),
  ]
    .sort((a, b) => {
      const ta = a.kind === "card" ? (a.stripe_created ?? "") : a.created_at;
      const tb = b.kind === "card" ? (b.stripe_created ?? "") : b.created_at;
      return tb.localeCompare(ta);
    })
    .slice(0, 200);

  return (
    <PaymentsView
      role={staff.role}
      paymentsConfigured={Boolean(process.env.STRIPE_SECRET_KEY)}
      items={items}
      summary={summaryRows?.[0] ?? null}
      kiosks={(kioskRows ?? []).flatMap((k) => (k.slug ? [k.slug] : []))}
      businesses={businessesResult.data ?? []}
      filters={{
        from,
        to,
        business: businessFilter,
        q,
        source: sourceFilter,
      }}
    />
  );
}
