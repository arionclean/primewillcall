import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { CustomersList, type CustomerRow, CUSTOMERS_PAGE } from "./list";

/**
 * Customers. A searchable directory of guests, scoped by RLS (owner = all
 * businesses, manager = their business). Check-in staff do not get it. The
 * first page is server-rendered; search and "load more" run on the browser
 * client (still RLS-scoped). Booking history lives on each customer's page.
 */
export default async function CustomersPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/customers");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/dashboard");

  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("customers")
    .select(
      "id, full_name, phone, email, business_id, created_at, business:businesses(name)",
    )
    .order("created_at", { ascending: false })
    .limit(CUSTOMERS_PAGE);

  const initial = (data ?? []) as unknown as CustomerRow[];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search guests by name, phone, or email. Open one to see their booking
          history.
        </p>
      </header>

      <CustomersList initial={initial} isOwner={staff.role === "owner"} />
    </div>
  );
}
