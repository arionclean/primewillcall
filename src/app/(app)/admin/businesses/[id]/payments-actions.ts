"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import {
  STRIPE_META,
  accountFeesPayer,
  appBaseUrl,
  connectControllerParams,
  getStripeClient,
  isFeeFreeAccount,
} from "@/lib/stripe/server";
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
 * NEW accounts are created with controller properties (see
 * `connectControllerParams`), NOT `type: "express"`, so Stripe bills its Connect
 * fees to the business instead of to Prime. Businesses still on an old
 * `type: "express"` account (the Xano-era fleet) migrate with
 * startFeeFreeMigration -> onboard -> switchToPendingAccount, which runs both
 * accounts side by side so there is no window where charges fail. Already-onboarded
 * accounts can also be attached as-is with linkExistingAccount.
 */

export type PaymentsActionResult = {
  error?: string;
  url?: string;
  ok?: true;
};

/** Which of a business's two account slots an action targets. */
export type AccountTarget = "primary" | "pending";

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
        controller: connectControllerParams(),
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
        .update({
          stripe_account_id: account.id,
          stripe_fees_payer: accountFeesPayer(account),
        })
        .eq("id", businessId);
    } catch (err) {
      return { error: stripeMessage(err) };
    }
  }

  return createOnboardingLink(businessId);
}

/** Resolve the acct_ id in one of the two slots. */
async function accountIdFor(
  businessId: string,
  target: AccountTarget,
): Promise<string | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const { data: biz } = await admin
    .from("businesses")
    .select("stripe_account_id, stripe_account_id_pending")
    .eq("id", businessId)
    .maybeSingle();
  return (
    (target === "pending" ? biz?.stripe_account_id_pending : biz?.stripe_account_id) ??
    null
  );
}

/** Hosted onboarding (or requirement-fixing) link for the connected account. */
export async function createOnboardingLink(
  businessId: string,
  target: AccountTarget = "primary",
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId);
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  if (!stripe) return { error: "Payments are not configured yet." };

  const base = appBaseUrl();
  if (!base) {
    return { error: "Set NEXT_PUBLIC_APP_URL to enable Stripe onboarding links." };
  }

  const accountId = await accountIdFor(businessId, target);
  if (!accountId) {
    return { error: "This business has no Stripe account yet." };
  }

  try {
    const link = await stripe.accountLinks.create({
      account: accountId,
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
  target: AccountTarget = "primary",
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId);
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  if (!stripe) return { error: "Payments are not configured yet." };

  const accountId = await accountIdFor(businessId, target);
  if (!accountId) {
    return { error: "This business has no Stripe account yet." };
  }

  try {
    const link = await stripe.accounts.createLoginLink(accountId);
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
        stripe_fees_payer: accountFeesPayer(account),
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
        stripe_fees_payer: accountFeesPayer(account),
        stripe_account_synced_at: new Date().toISOString(),
      })
      .eq("id", businessId);
    revalidatePath(`/admin/businesses/${businessId}`);
    return { ok: true };
  } catch (err) {
    return { error: stripeMessage(err) };
  }
}

/**
 * Owner-only: start moving a business off platform-paid Connect fees.
 *
 * Creates a SECOND connected account with the fee-free controller properties and
 * parks it in `stripe_account_id_pending`. The live account keeps taking every
 * charge until switchToPendingAccount runs, so this is safe to call at any time.
 * Returns an onboarding link for the new account. Calling it again while a pending
 * account exists just re-links that one instead of creating another.
 */
export async function startFeeFreeMigration(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId, { ownerOnly: true });
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const { data: biz } = await admin
    .from("businesses")
    .select(
      "id, name, contact_email, stripe_account_id, stripe_account_id_pending, stripe_fees_payer",
    )
    .eq("id", businessId)
    .maybeSingle();
  if (!biz) return { error: "Business not found." };
  if (biz.stripe_account_id_pending) {
    return createOnboardingLink(businessId, "pending");
  }
  if (!biz.stripe_account_id) {
    return { error: "Set up payments for this business first." };
  }
  if (isFeeFreeAccount(biz.stripe_fees_payer)) {
    return { error: "This business is already on fee-free pricing." };
  }

  try {
    const account = await stripe.accounts.create({
      controller: connectControllerParams(),
      country: "US",
      email: biz.contact_email ?? undefined,
      business_profile: { name: biz.name },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        [STRIPE_META.businessId]: biz.id,
        migrated_from_account_id: biz.stripe_account_id,
      },
    });
    await admin
      .from("businesses")
      .update({ stripe_account_id_pending: account.id })
      .eq("id", businessId);
    revalidatePath(`/admin/businesses/${businessId}`);
  } catch (err) {
    return { error: stripeMessage(err) };
  }

  return createOnboardingLink(businessId, "pending");
}

/**
 * Owner-only: make the pending fee-free account the live one.
 *
 * Refuses until Stripe reports `charges_enabled` on the new account, because a
 * premature flip would fail every checkout. The old account id moves into
 * `stripe_account_id_legacy` rather than being dropped, and stays open on Stripe so
 * its remaining balance pays out. Refunds of charges it already took keep working:
 * the refund action routes by `stripe_transactions.connected_account_id`.
 */
export async function switchToPendingAccount(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId, { ownerOnly: true });
  if (gate.error) return { error: gate.error };

  const stripe = getStripeClient();
  const admin = getSupabaseAdminClient();
  if (!stripe || !admin) return { error: "Payments are not configured yet." };

  const { data: biz } = await admin
    .from("businesses")
    .select("stripe_account_id, stripe_account_id_pending, stripe_account_id_legacy")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz?.stripe_account_id_pending) {
    return { error: "There is no new account waiting to switch to." };
  }

  try {
    const account = await stripe.accounts.retrieve(biz.stripe_account_id_pending);
    if (!account.charges_enabled) {
      return {
        error:
          "Stripe has not enabled charges on the new account yet. Finish onboarding first.",
      };
    }

    const legacy = [...(biz.stripe_account_id_legacy ?? [])];
    if (biz.stripe_account_id && !legacy.includes(biz.stripe_account_id)) {
      legacy.push(biz.stripe_account_id);
    }

    await admin
      .from("businesses")
      .update({
        stripe_account_id: account.id,
        stripe_account_id_pending: null,
        stripe_account_id_legacy: legacy,
        stripe_charges_enabled: Boolean(account.charges_enabled),
        stripe_payouts_enabled: Boolean(account.payouts_enabled),
        stripe_details_submitted: Boolean(account.details_submitted),
        stripe_requirements_due: account.requirements?.currently_due?.length ?? 0,
        stripe_fees_payer: accountFeesPayer(account),
        stripe_account_synced_at: new Date().toISOString(),
      })
      .eq("id", businessId);
    revalidatePath(`/admin/businesses/${businessId}`);
    return { ok: true };
  } catch (err) {
    return { error: stripeMessage(err) };
  }
}

/**
 * Owner-only: forget the pending account. Only clears our pointer; the Stripe
 * account itself is left alone (deleting one is not something to do from a button).
 */
export async function cancelFeeFreeMigration(
  businessId: string,
): Promise<PaymentsActionResult> {
  const gate = await requireBusinessAccess(businessId, { ownerOnly: true });
  if (gate.error) return { error: gate.error };

  const admin = getSupabaseAdminClient();
  if (!admin) return { error: "Payments are not configured yet." };

  await admin
    .from("businesses")
    .update({ stripe_account_id_pending: null })
    .eq("id", businessId);
  revalidatePath(`/admin/businesses/${businessId}`);
  return { ok: true };
}
