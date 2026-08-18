import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { nyDateISO, nyLocalToUtcIso, shiftDayISO } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { PaymentsView, type FeedItem } from "./payments-view";
import { parsePaymentsSearch } from "./search";

/**
 * Payments ledger for owner + business manager. Supabase-native replacement for
 * the Xano transactions screens (stripe/transactions/list, account/transactions).
 *
 * The feed merges two RLS-scoped sources: card charges from stripe_transactions
 * (webhook-fed) and kiosk cash sales from cash_sales. Both the merge and the
 * paging happen in the database, in the payments_feed RPC: merging two tables
 * in JS cannot be paged (an offset applied to each source separately does not
 * offset the merged list), and the 1000-row read cap would truncate it anyway.
 * Owner sees every business, a manager only their own; check_in is redirected
 * out. Totals come from the payments_summary RPC, also aggregated in the DB.
 */

// Default window: the current month to date, in business time
// (America/New_York) so the server default matches the client's "This month"
// range preset.

// Source filter values are kiosk slugs (from the kiosks table) plus the
// static channels; accept anything slug-shaped, the queries are parameterized.
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/i;

// One screen of sales. The RPC pages in the database, so this is exactly how
// many rows each request reads.
const PER_PAGE = 50;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    business?: string;
    q?: string;
    source?: string;
    page?: string;
  }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/admin/payments");
  if (staff.role === "check_in") redirect("/dashboard");

  const sp = await searchParams;
  const to = sp.to ?? nyDateISO();
  const from = sp.from ?? `${to.slice(0, 8)}01`;
  const businessFilter = sp.business && sp.business !== "" ? sp.business : null;
  const sourceFilter =
    sp.source && SOURCE_RE.test(sp.source) ? sp.source : null;
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  // Smart search: words like "cash", "refunded" or "aug 10" become real
  // filters, the rest stays a name / email / last4 / sale-ref match.
  const search = parsePaymentsSearch(q, nyDateISO());

  // Naming a day overrides the range picker. Otherwise searching a date
  // outside the current range would return nothing and look broken.
  const rangeFrom = search.onDate ?? from;
  const rangeTo = search.onDate ?? to;

  // Day bounds in business time: "today" means the New York day, matching how
  // the rows are displayed. End bound is the last ms before the next NY day.
  const startIso = nyLocalToUtcIso(rangeFrom, "00:00");
  const endIso = new Date(
    new Date(nyLocalToUtcIso(shiftDayISO(rangeTo, 1), "00:00")).getTime() - 1,
  ).toISOString();

  const supabase = await getSupabaseServerClient();

  const [
    { data: feedRows },
    { data: summaryRows },
    { data: kioskRows },
    businessesResult,
  ] = await Promise.all([
    supabase.rpc("payments_feed", {
      p_start: startIso,
      p_end: endIso,
      p_business: businessFilter ?? undefined,
      p_source: sourceFilter ?? undefined,
      p_q: search.text || undefined,
      p_tender: search.tender ?? undefined,
      p_status: search.status ?? undefined,
      p_limit: PER_PAGE,
      p_offset: (page - 1) * PER_PAGE,
    }),
    // Same filters as the feed (they share payments_scope in the DB), so the
    // totals always describe exactly the rows listed below them.
    supabase.rpc("payments_summary", {
      p_start: startIso,
      p_end: endIso,
      p_business: businessFilter ?? undefined,
      p_source: sourceFilter ?? undefined,
      p_q: search.text || undefined,
      p_tender: search.tender ?? undefined,
      p_status: search.status ?? undefined,
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

  const rows = feedRows ?? [];

  // Past the last page (a stale link, or the range narrowed while paging):
  // send them back to the first page rather than to an empty dead end.
  if (rows.length === 0 && page > 1) {
    const params = new URLSearchParams();
    if (sp.from) params.set("from", from);
    if (sp.to) params.set("to", to);
    if (businessFilter) params.set("business", businessFilter);
    if (sourceFilter) params.set("source", sourceFilter);
    if (q) params.set("q", q);
    redirect(`/admin/payments?${params.toString()}`);
  }

  // Deep link into the bookings list: it shows one NY day at a time and
  // highlights ?booking=<id>.
  const bookingHref = (id: string | null, startsAt: string | null) =>
    id && startsAt
      ? `/bookings?date=${nyDateISO(new Date(startsAt))}&booking=${id}`
      : null;

  const items: FeedItem[] = rows.map((r) => {
    const booking_href = bookingHref(r.booking_id, r.booking_starts_at);
    const business = r.business_name ? { name: r.business_name } : null;
    return r.kind === "cash"
      ? {
          kind: "cash" as const,
          id: r.id,
          business_id: r.business_id,
          booking_ref: r.booking_ref,
          amount_cents: r.amount,
          amount_refunded_cents: r.amount_refunded,
          kiosk_slug: r.source,
          created_at: r.occurred_at,
          customer_name: r.customer_name,
          source_original: r.source_original,
          business,
          booking_href,
        }
      : {
          kind: "card" as const,
          id: r.id,
          stripe_id: r.stripe_id ?? "",
          business_id: r.business_id,
          amount: r.amount,
          amount_refunded: r.amount_refunded,
          currency: r.currency,
          status: r.status,
          source: r.source,
          card_brand: r.card_brand,
          card_last4: r.card_last4,
          booking_id: r.booking_id,
          booking_ref: r.booking_ref,
          customer_email: r.customer_email,
          customer_name: r.customer_name,
          receipt_url: r.receipt_url,
          stripe_created: r.occurred_at,
          object_type: "charge",
          source_original: r.source_original,
          business,
          booking_href,
        };
  });

  return (
    <PaymentsView
      role={staff.role}
      items={items}
      summary={summaryRows?.[0] ?? null}
      kiosks={(kioskRows ?? []).flatMap((k) => (k.slug ? [k.slug] : []))}
      businesses={businessesResult.data ?? []}
      page={page}
      perPage={PER_PAGE}
      total={rows[0]?.total_count ?? 0}
      searchLabels={search.labels}
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
