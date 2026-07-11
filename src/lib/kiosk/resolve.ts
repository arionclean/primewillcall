import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

/**
 * A kiosk resolved to the Stripe Connect account its sales settle on. `account`
 * is the connected account id (acct_...): the per-kiosk override when set,
 * otherwise the kiosk's business's account. `location` is the Terminal Location
 * (tml_...) to scope readers, returned to the tablet (may be null until a
 * Location is created on that account).
 */
export type ResolvedKiosk = {
  kioskId: string;
  businessId: string | null;
  account: string;
  location: string | null;
  simulated: boolean;
};

/**
 * Resolve the tablet's `kiosk` tag (kiosks.slug) to its connected account.
 * Runs with the service-role admin client (the tablet has no user session), so
 * it bypasses RLS. Returns null when the kiosk is unknown or no connected
 * account can be resolved (kiosk has no override and its business is not
 * onboarded), which the caller turns into a clear error.
 */
export async function resolveKioskAccount(
  admin: Admin,
  slug: string,
): Promise<ResolvedKiosk | null> {
  const { data: kiosk } = await admin
    .from("kiosks")
    .select("id, business_id, stripe_account_id, terminal_location_id, simulated")
    .eq("slug", slug)
    .maybeSingle();
  if (!kiosk) return null;

  let account = kiosk.stripe_account_id ?? null;
  if (!account && kiosk.business_id) {
    const { data: biz } = await admin
      .from("businesses")
      .select("stripe_account_id")
      .eq("id", kiosk.business_id)
      .maybeSingle();
    account = biz?.stripe_account_id ?? null;
  }
  if (!account) return null;

  return {
    kioskId: kiosk.id,
    businessId: kiosk.business_id ?? null,
    account,
    location: kiosk.terminal_location_id ?? null,
    simulated: kiosk.simulated ?? false,
  };
}
