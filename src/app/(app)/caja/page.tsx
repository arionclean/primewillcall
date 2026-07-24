import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { nyDateISO, nyLocalToUtcIso, shiftDayISO } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { CajaView, type CajaItem } from "./caja-view";

/**
 * Caja: one selling desk's own money for a single day (cash + card), plus an
 * end-of-night drawer reconciliation. Built for check-in (kiosk) staff, who do
 * not get the full /admin/payments ledger.
 *
 * The check-in login IS the kiosk, so everything is scoped to that account's own
 * kiosk_slug — cash_sales.kiosk_slug and stripe_transactions.source both equal it.
 * RLS enforces the same per-kiosk scope (migration 20260723190000); the explicit
 * filters here keep intent clear. A business can run several kiosks, so this is
 * deliberately per-kiosk, never per-business — each tablet reconciles its own drawer.
 *
 * One New York day at a time (the business operating timezone). Owners have no
 * single business, so they are sent to the full ledger instead.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function CajaPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) redirect("/login?next=/caja");
  // Owner spans every business; the full ledger is their tool.
  if (staff.role === "owner") redirect("/admin/payments");
  if (!staff.business_id) redirect("/bookings");
  const businessId = staff.business_id;
  // The check-in login IS the kiosk; it sells and reconciles as this slug.
  const kioskSlug = staff.kiosk_slug ?? null;

  const sp = await searchParams;
  const day = sp.date && DATE_RE.test(sp.date) ? sp.date : nyDateISO();

  // Not linked to a kiosk yet (a check-in login created before its slug was set):
  // there is nothing to scope to, so show an explicit empty caja rather than risk
  // another desk's money.
  if (!kioskSlug) {
    return (
      <CajaView
        day={day}
        today={nyDateISO()}
        items={[]}
        totals={{
          cashReceivedCents: 0,
          cardGrossCents: 0,
          cardRefundedCents: 0,
          cashCount: 0,
          cardCount: 0,
        }}
        kioskLabel={staff.full_name}
        notice="This account isn't linked to a kiosk yet, so there are no sales to show. Ask an owner to set its kiosk."
      />
    );
  }

  // Day bounds in business time: the whole NY day, ending at the last
  // millisecond before the next NY day begins.
  const startIso = nyLocalToUtcIso(day, "00:00");
  const endIso = new Date(
    new Date(nyLocalToUtcIso(shiftDayISO(day, 1), "00:00")).getTime() - 1,
  ).toISOString();

  const supabase = await getSupabaseServerClient();

  const [{ data: cashRows }, { data: cardRows }] = await Promise.all([
    supabase
      .from("cash_sales")
      .select("id, booking_ref, amount_cents, status, created_at")
      .eq("business_id", businessId)
      .eq("kiosk_slug", kioskSlug)
      .eq("type", "cash")
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("created_at", { ascending: false })
      .limit(300),
    // This kiosk's own card charges. source = the kiosk_slug (kiosk1..kioskN);
    // RLS enforces the same per-kiosk scope, these filters just make it explicit.
    supabase
      .from("stripe_transactions")
      .select(
        "id, amount, amount_refunded, currency, status, card_brand, card_last4, booking_ref, customer_name, stripe_created",
      )
      .eq("business_id", businessId)
      .eq("object_type", "charge")
      .eq("source", kioskSlug)
      .gte("stripe_created", startIso)
      .lte("stripe_created", endIso)
      .order("stripe_created", { ascending: false })
      .limit(300),
  ]);

  // Put a customer name on cash sales the way /admin/payments does: the tablet
  // stamps the KS code in booking_ref, which equals bookings.legacy_id.
  const cashRefs = (cashRows ?? []).flatMap((c) =>
    c.booking_ref ? [c.booking_ref] : [],
  );
  const nameByRef = new Map<string, string | null>();
  if (cashRefs.length > 0) {
    const { data: linked } = await supabase
      .from("bookings")
      .select("legacy_id, customer:customers(full_name)")
      .in("legacy_id", cashRefs);
    for (const b of linked ?? []) {
      if (b.legacy_id) {
        nameByRef.set(b.legacy_id, b.customer?.full_name?.trim() || null);
      }
    }
  }

  const items: CajaItem[] = [
    ...(cashRows ?? []).map((c) => ({
      kind: "cash" as const,
      id: c.id,
      at: c.created_at,
      amountCents: c.amount_cents ?? 0,
      status: c.status,
      // A cash sale "went through" when the tablet marked it success.
      ok: c.status === "success",
      label:
        (c.booking_ref ? nameByRef.get(c.booking_ref) : null) ??
        (c.booking_ref ? `Sale ${c.booking_ref}` : "Cash sale"),
      method: "Cash",
    })),
    ...(cardRows ?? []).map((t) => ({
      kind: "card" as const,
      id: t.id,
      at: t.stripe_created ?? "",
      amountCents: t.amount ?? 0,
      refundedCents: t.amount_refunded ?? 0,
      status: t.status,
      ok: t.status === "succeeded" && (t.amount_refunded ?? 0) < (t.amount ?? 0),
      label:
        t.customer_name ??
        (t.booking_ref ? `Sale ${t.booking_ref}` : "Card sale"),
      method: t.card_last4
        ? `${t.card_brand ? cap(t.card_brand) + " " : ""}···· ${t.card_last4}`
        : "Card",
    })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  // Totals. Cash received (successful) is what the drawer should hold. Card is
  // informational for "how much did I make" and never touches the drawer.
  const cashReceivedCents = (cashRows ?? [])
    .filter((c) => c.status === "success")
    .reduce((s, c) => s + (c.amount_cents ?? 0), 0);
  const cardGrossCents = (cardRows ?? [])
    .filter((t) => t.status === "succeeded")
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const cardRefundedCents = (cardRows ?? []).reduce(
    (s, t) => s + (t.amount_refunded ?? 0),
    0,
  );
  const cashCount = (cashRows ?? []).filter(
    (c) => c.status === "success",
  ).length;
  const cardCount = (cardRows ?? []).filter(
    (t) => t.status === "succeeded",
  ).length;

  return (
    <CajaView
      day={day}
      today={nyDateISO()}
      items={items}
      kioskLabel={staff.full_name}
      totals={{
        cashReceivedCents,
        cardGrossCents,
        cardRefundedCents,
        cashCount,
        cardCount,
      }}
    />
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
