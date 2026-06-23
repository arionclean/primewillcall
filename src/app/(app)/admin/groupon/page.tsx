import { getSupabaseServerClient } from "@/lib/supabase/server";

import { GrouponFeesForm, type GrouponProductRow } from "./groupon-form";

/**
 * Owner-only config: the per-product Groupon convenience fee. This is the price
 * a Groupon customer is charged on the public /gp page when they redeem a
 * voucher for that product. NULL = the product does not accept Groupon.
 */
export default async function GrouponConfigPage() {
  const supabase = await getSupabaseServerClient();

  const { data, error } = await supabase
    .from("business_tours")
    .select(
      "id, name, is_active, groupon_fee_cents, business:businesses!business_tours_business_id_fkey(id, name), tour:tours!business_tours_tour_id_fkey(name)",
    );

  type Joined = {
    id: string;
    name: string;
    is_active: boolean;
    groupon_fee_cents: number | null;
    business: { id: string; name: string } | null;
    tour: { name: string } | null;
  };
  const rows = ((data ?? []) as unknown as Joined[])
    .map<GrouponProductRow>((r) => ({
      id: r.id,
      productName: r.name,
      isActive: r.is_active,
      grouponFeeCents: r.groupon_fee_cents,
      businessId: r.business?.id ?? "",
      businessName: r.business?.name ?? "Unknown business",
    }))
    .sort(
      (a, b) =>
        a.businessName.localeCompare(b.businessName) ||
        a.productName.localeCompare(b.productName),
    );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Groupon fees</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the convenience fee charged per guest when a customer redeems a
          Groupon voucher on the public booking page. Turn a product off to stop
          accepting Groupon for it.
        </p>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load products: {error.message}
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
          No products yet. Add tours to a business first.
        </p>
      ) : (
        <GrouponFeesForm rows={rows} />
      )}
    </div>
  );
}
