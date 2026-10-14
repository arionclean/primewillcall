import { invokeStripeFunction } from "@/lib/payments/edge";

/**
 * The owner's Payouts tab talks to the `stripe-reports` edge function, which
 * reads Stripe (it never writes to it). These are the shapes it answers with,
 * the call itself, and the words the tab uses for Stripe's codes.
 */

export type HealthLevel = "ok" | "attention" | "blocked";

export type BusinessOverview = {
  id: string;
  name: string;
  accountId: string;
  /** Set when Stripe could not be read for this business; the rest is null then. */
  error: string | null;
  health: { level: HealthLevel; messages: string[]; deadline: string | null } | null;
  /**
   * Cents. `available` can be sent now; `pending` is still clearing. Like every number
   * here, summed over all the Stripe accounts the business has had, so moving it to a
   * new account never shows.
   */
  balance: { available: number; pending: number } | null;
  /**
   * From Stripe: a payout already sent and not yet arrived, else the earliest day
   * money finishes clearing. Null when nothing is clearing; missing when Stripe
   * could not be read for it.
   */
  nextPayout?: { date: string; amount: number; onTheWay: boolean } | null;
  /** Cents in payouts Stripe has sent that have not arrived (out of the balance). */
  inTransit: number;
};

export type Overview = { businesses: BusinessOverview[] };

export type PayoutLine = {
  id: string;
  kind: "sale" | "refund" | "dispute" | "other";
  created: string;
  amount: number;
  fee: number;
  stripeFee: number;
  platformFee: number;
  net: number;
  description: string | null;
  customerName: string | null;
  bookingId: string | null;
  bookingRef: string | null;
  bookingStartsAt: string | null;
  source: string | null;
};

export type PayoutDetail = { lines: PayoutLine[]; truncated: boolean; note: string | null };

/** Call stripe-reports (reads Stripe, never writes to it) as the signed-in owner. */
export function invokeStripeReports<T>(
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  return invokeStripeFunction<T>("stripe-reports", body);
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export function payoutStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "paid":
      return { label: "Paid", tone: "success" };
    case "in_transit":
      return { label: "On the way", tone: "info" };
    case "pending":
      return { label: "Scheduled", tone: "info" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "canceled":
      return { label: "Canceled", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/** "kiosk2" reads as "Kiosk 2"; the channels get their names; ids get nothing. */
export function saleSourceLabel(source: string | null): string | null {
  if (!source) return null;
  if (source === "online") return "Online";
  if (source === "groupon") return "Groupon";
  if (source === "schedule") return "Staff booking";
  const kiosk = source.match(/^kiosk(\d+)$/i);
  if (kiosk) return `Kiosk ${kiosk[1]}`;
  return /^[a-z][a-z0-9 _-]{0,15}$/i.test(source) ? source : null;
}

/** Stripe's public price lists, linked from the fee names in a payout. */
export const STRIPE_PRICING_URL = "https://stripe.com/pricing";
export const STRIPE_CONNECT_PRICING_URL = "https://stripe.com/connect/pricing";

/** Prime's live platform account: the Stripe account every business is connected to. */
const PRIME_PLATFORM_ACCOUNT_ID = "acct_1P3rN4FK2DDqkJsm";

/**
 * Stripe's page for a business's account, in Prime's own Stripe dashboard. The platform id
 * in the path makes Stripe switch to Prime's account first: without it the link opens in
 * whichever account the login last used, cannot find the business there, and lands on home.
 */
export function stripeAccountUrl(accountId: string): string {
  return `https://dashboard.stripe.com/${PRIME_PLATFORM_ACCOUNT_ID}/connect/accounts/${accountId}`;
}
