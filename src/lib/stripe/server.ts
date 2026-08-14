import Stripe from "stripe";

/**
 * Server-only Stripe client for the platform (Prime) account.
 *
 * The secret key is Prime's PLATFORM key: it can reach every connected account
 * (each business is a Stripe Connect account). Charges are created DIRECTLY on a
 * connected account (`{ stripeAccount }` request option) with a platform
 * `application_fee_amount`, matching the legacy Xano model. Never import this
 * into a client component; the key must never reach the browser.
 *
 * `getStripeClient()` returns null when the key is unset so routes/actions can
 * degrade to a clear "payments not configured" message instead of crashing
 * (mirrors `getSupabaseAdminClient()`).
 */

// Pin the API version so behavior is stable across SDK upgrades instead of
// silently following the account default. Derive the accepted type from the
// constructor (not a named export, which moves between SDK majors) and cast, so
// the build stays green even if this exact literal is not in the SDK's union;
// the runtime value is still this pinned string.
export const STRIPE_API_VERSION = "2026-04-22.dahlia";

type StripeApiVersion = NonNullable<
  ConstructorParameters<typeof Stripe>[1]
>["apiVersion"];

let cached: Stripe | null = null;

export function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (cached) return cached;
  cached = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION as unknown as StripeApiVersion,
    typescript: true,
    appInfo: { name: "PrimeWillCall", url: "https://app.primewillcall.com" },
  });
  return cached;
}

/**
 * Controller properties for every NEW connected account.
 *
 * Do NOT go back to `type: "express"`. That shorthand assigns
 * `controller.fees.payer = "application_express"`, which bills Stripe's Connect
 * fees ($2 per monthly active account + 0.25% of payout volume) to PRIME. Spelling
 * the controller out instead gives the business the same Express dashboard and the
 * same Stripe-run onboarding, while Stripe collects its fees from the business and
 * charges the platform nothing. Prime's `application_fee_amount` is unaffected.
 *
 * `losses.payments: "stripe"` also moves negative-balance liability off Prime,
 * which is what Stripe recommends for direct charges.
 */
export function connectControllerParams(): Stripe.AccountCreateParams.Controller {
  return {
    stripe_dashboard: { type: "express" },
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

/**
 * Metadata keys written on every charge so the webhook + ledger can link a
 * Stripe object back to a booking. Standardized on `booking_id` everywhere
 * (the legacy Xano checkout path used `internal_id`, which the webhook did not
 * read, so those charges lost their booking link; do not repeat that here).
 */
export const STRIPE_META = {
  bookingId: "booking_id",
  source: "source",
  businessId: "business_id",
} as const;

/**
 * Global platform (Prime) fee in basis points. 25 bps = 0.25%, which is what
 * Stripe charges the platform for Connect, passed through as the application fee.
 * This is a single GLOBAL rate (not per-business). Override with the
 * STRIPE_PLATFORM_FEE_BPS env var if the deal changes.
 *
 * Note: on accounts using `connectControllerParams()` Prime pays no Connect fee,
 * so this 0.25% stops being a pass-through and becomes margin. Whether to keep it,
 * drop it, or re-price it is a business call, so the rate is left alone here.
 */
export const DEFAULT_PLATFORM_FEE_BPS = 25;

export function platformFeeBps(): number {
  const raw = Number(process.env.STRIPE_PLATFORM_FEE_BPS);
  return Number.isFinite(raw) && raw >= 0 && raw <= 10000
    ? Math.floor(raw)
    : DEFAULT_PLATFORM_FEE_BPS;
}

/**
 * Platform application fee in cents for a direct charge, at the global rate.
 * Clamped below the amount because Stripe rejects an application fee >= the
 * charge amount.
 */
export function computeApplicationFeeCents(amountCents: number): number {
  const bps = platformFeeBps();
  if (!Number.isFinite(amountCents) || amountCents <= 0 || bps <= 0) return 0;
  const fee = Math.floor((amountCents * bps) / 10000);
  return Math.max(0, Math.min(fee, amountCents - 1));
}

/** Absolute app base URL (no trailing slash) for Stripe redirect/return URLs. */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
}
