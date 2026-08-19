/**
 * Stripe client and Connect helpers for the edge functions.
 *
 * The platform key lives here and only here. Every Stripe call the app makes now
 * runs in Supabase, so `STRIPE_SECRET_KEY` is a function secret and no longer
 * needs to exist on Vercel at all. Keep this in sync with the webhook's own copy
 * of META and with `src/lib/stripe/server.ts`, which is down to the pieces the
 * Next side still computes without calling Stripe.
 *
 * `Stripe.createFetchHttpClient()` is required: the SDK's default HTTP client is
 * Node's http module, which Deno does not provide.
 */

import Stripe from "npm:stripe@22.3.0";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

/** Null when the key is unset, so callers answer "not configured" instead of throwing. */
export function getStripe(): Stripe | null {
  if (!STRIPE_SECRET_KEY) return null;
  return new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

export function stripeConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY);
}

/**
 * Absolute app base URL (no trailing slash) for Stripe redirect and return URLs.
 *
 * A function secret, never a value the caller sends. Stripe will redirect a real
 * merchant to whatever `return_url` we hand it, so letting the browser choose it
 * would turn onboarding into an open redirect.
 */
export function appBaseUrl(): string {
  return (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
}

/**
 * Controller properties for every NEW connected account.
 *
 * `fees.payer: "account"` is the whole point: Stripe bills its fees to the
 * business, so Prime pays no Connect fee ($2 per monthly active account + 0.25%
 * of payout volume). Do NOT go back to `type: "express"`, which assigns
 * `fees.payer = "application_express"` and puts all of that on Prime.
 *
 * The dashboard is `none`, and that is forced by the fee choice. Stripe rejects
 * an Express dashboard whenever the business pays its own fees:
 * "When stripe_dashboard[type]=express, your platform must collect fees and be
 * liable for negative balances." Accounts v2 enforces the same rule
 * (`account_controller_express_dash_without_application_losses_or_fees`), so this
 * is not something a newer API unlocks. That leaves `full`, which hands the
 * business an ordinary Stripe account, or `none`, which keeps the account inside
 * PrimeWillCall. We want the second.
 *
 * `none` is only unsupported when requirement collection AND loss liability both
 * sit with the platform. Here Stripe carries both, so it is allowed, and Stripe
 * still runs hosted onboarding and KYC.
 *
 * Two consequences for callers:
 *   - `accounts.createLoginLink` is Express-only. Never call it for these.
 *   - There is no self-serve dashboard, and `account_update` links are not
 *     available when Stripe is liable for losses. A business that needs to change
 *     its own bank details later needs Connect embedded components, which are not
 *     built yet.
 */
export function connectControllerParams(): Stripe.AccountCreateParams.Controller {
  return {
    stripe_dashboard: { type: "none" },
    fees: { payer: "account" },
    losses: { payments: "stripe" },
    requirement_collection: "stripe",
  };
}

/** The one `fees.payer` value where Stripe bills the business, not the platform. */
export const FEE_FREE_FEES_PAYER = "account";

/** True when Prime pays no Stripe Connect fees on this account. */
export function isFeeFreeAccount(feesPayer: string | null | undefined): boolean {
  return feesPayer === FEE_FREE_FEES_PAYER;
}

/** `controller.fees.payer` off a retrieved account, or null if Stripe omitted it. */
export function accountFeesPayer(account: Stripe.Account): string | null {
  return account.controller?.fees?.payer ?? null;
}

/** Metadata keys written on every charge (mirrors src/lib/stripe/server.ts). */
export const STRIPE_META = {
  bookingId: "booking_id",
  source: "source",
  businessId: "business_id",
} as const;

/** The status columns `businesses` mirrors from a retrieved account. */
export function accountStatusColumns(account: Stripe.Account) {
  return {
    stripe_charges_enabled: Boolean(account.charges_enabled),
    stripe_payouts_enabled: Boolean(account.payouts_enabled),
    stripe_details_submitted: Boolean(account.details_submitted),
    stripe_requirements_due: account.requirements?.currently_due?.length ?? 0,
    stripe_fees_payer: accountFeesPayer(account),
    stripe_account_synced_at: new Date().toISOString(),
  };
}

/**
 * Turn a Stripe error into something an operator can act on.
 *
 * The key-mismatch case matters most: a test key cannot open a live connected
 * account, and every Xano-era account was created live, so Stripe answers with a
 * wall of asterisks that reads like a broken integration when it is really a
 * mode mismatch.
 */
export function stripeErrorMessage(err: unknown): string {
  const raw =
    err && typeof err === "object" && "message" in err &&
      typeof (err as { message: unknown }).message === "string"
      ? (err as { message: string }).message
      : null;

  if (raw && /does not have access to account|Application access may have been revoked/i.test(raw)) {
    return "Stripe will not open this account with the key this app is running on. It was created under Prime's other Stripe mode, so its status cannot be read or changed from here. Creating the new account for this business still works.";
  }
  return raw ?? "Stripe request failed.";
}
