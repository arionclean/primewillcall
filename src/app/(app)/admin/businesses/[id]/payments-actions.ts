"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { STRIPE_META, appBaseUrl, getStripeClient } from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe Connect onboarding for a business's connected account. Charges are
 * created directly on this account with a platform application_fee.
 *
 * Layered auth: /admin/businesses/* is already owner-gated by its layout. These
 * actions re-check the role themselves (owner, or the business's own manager for
 * the non-destructive ones), then write with the service-role admin client. The
 * `businesses` Stripe columns have no manager UPDATE policy, so the service role
 * is what keeps this working if a manager-facing settings page is added later.
 *
 * NOTE: accounts are created as v1 Express to match the existing (Xano-era)
 * connected-account fleet on Prime's platform. Already-onboarded businesses are
 * attached with linkExistingAccount (no re-onboarding, no Xano access).
 */

export type PaymentsActionResult = {
  error?: string;
  url?: string;
  ok?: true;
};

async function requireBusinessAccess(
  businessId: string,
  opts?: { ownerOnly?: boolean },
): Promise<{ error: string | null }> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not authorized." };
  const isOwner = staff.role === "owner";
  const isManagerOfBiz =
    staff.role === "business_manager" && staff.business_id === businessId;
  const ok = opts?.ownerOnly ? isOwner : isOwner || isManagerOfBiz;
  return { error: ok ? null : "Not authorized." };
}

function stripeMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return "Stripe request failed.";
}

/** Create the connected account if missing, then return an onboarding link. */
export async function createConnectAccount(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId);
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const { data: biz } = await admin
    .from("businesses")
    .select("id, name, contact_email, stripe_account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz) return { error: "Business not found." };

  if (!biz.stripe_account_id) {
    try {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: biz.contact_email ?? undefined,
        business_profile: { name: biz.name },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { [STRIPE_META.businessId]: biz.id },
      });
      await admin
        .from("businesses")
        .update({ stripe_account_id: account.id })
        .eq("id", businessId);
    } catch (err) {
      return { error: stripeMessage(err) };
    }
  }

  return createOnboardingLink(businessId);
}

/** Hosted onboarding (or requirement-fixing) link for the connected account. */
export async function createOnboardingLink(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId);
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const base = appBaseUrl();
  if (!base) {
    return { error: "Set NEXT_PUBLIC_APP_URL to enable Stripe onboarding links." };
  }

  const { data: biz } = await admin
    .from("businesses")
    .select("stripe_account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz?.stripe_account_id) {
    return { error: "This business has no Stripe account yet." };
  }

  try {
    const link = await stripe.accountLinks.create({
      account: biz.stripe_account_id,
      type: "account_onboarding",
      refresh_url: `${base}/admin/businesses/${businessId}?stripe=refresh`,
      return_url: `${base}/admin/businesses/${businessId}?stripe=return`,
      collection_options: { fields: "eventually_due" },
    });
    return { url: link.url };
  } catch (err) {
    return { error: stripeMessage(err) };
  }
}

/** Express-dashboard login link for an onboarded account. */
export async function createLoginLink(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId);
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const { data: biz } = await admin
    .from("businesses")
    .select("stripe_account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz?.stripe_account_id) {
    return { error: "This business has no Stripe account yet." };
  }

  try {
    const link = await stripe.accounts.createLoginLink(biz.stripe_account_id);
    return { url: link.url };
  } catch (err) {
    return { error: stripeMessage(err) };
  }
}

/** Pull the latest account status from Stripe into the businesses row. */
export async function refreshAccountStatus(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId);
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const { data: biz } = await admin
    .from("businesses")
    .select("stripe_account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz?.stripe_account_id) {
    return { error: "This business has no Stripe account yet." };
  }

  try {
    const account = await stripe.accounts.retrieve(biz.stripe_account_id);
    await admin
      .from("businesses")
      .update({
        stripe_charges_enabled: Boolean(account.charges_enabled),
        stripe_payouts_enabled: Boolean(account.payouts_enabled),
        stripe_details_submitted: Boolean(account.details_submitted),
        stripe_requirements_due: account.requirements?.currently_due?.length ?? 0,
        stripe_account_synced_at: new Date().toISOString(),
      })
      .eq("id", businessId);
    revalidatePath(`/admin/businesses/${businessId}`);
    return { ok: true };
  } catch (err) {
    return { error: stripeMessage(err) };
  }
}

/** Owner-only: attach an existing connected account (e.g. from the Xano era). */
export async function linkExistingAccount(
  businessId: string,
  rawAccountId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId, { ownerOnly: true });
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const accountId = rawAccountId.trim();
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    return { error: "Enter a valid Stripe account id (starts with acct_)." };
  }

  const { data: clash } = await admin
    .from("businesses")
    .select("id")
    .eq("stripe_account_id", accountId)
    .neq("id", businessId)
    .maybeSingle();
  if (clash) {
    return { error: "That Stripe account is already linked to another business." };
  }

  try {
    const account = await stripe.accounts.retrieve(accountId);
    await admin
      .from("businesses")
      .update({
        stripe_account_id: account.id,
        stripe_charges_enabled: Boolean(account.charges_enabled),
        stripe_payouts_enabled: Boolean(account.payouts_enabled),
        stripe_details_submitted: Boolean(account.details_submitted),
        stripe_requirements_due: account.requirements?.currently_due?.length ?? 0,
        stripe_account_synced_at: new Date().toISOString(),
      })
      .eq("id", businessId);
    revalidatePath(`/admin/businesses/${businessId}`);
    return { ok: true };
  } catch (err) {
    return { error: stripeMessage(err) };
  }
}
