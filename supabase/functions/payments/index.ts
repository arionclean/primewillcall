// The /admin/payments money actions plus the booking payment link. Supabase-native
// replacement for the Vercel server actions in
// src/app/(app)/admin/payments/actions.ts and the route at
// src/app/(app)/bookings/[id]/payment-link/route.ts.
//
// All four actions live together because they share the REFUND_PIN gate. Splitting
// the Stripe ones out would put that passcode, and its secret, in two runtimes.
//
// Deployed with JWT ON. requireStaff turns the caller's token into their staff row;
// every action then re-checks the role and, for the money ones, the passcode.
// check_in staff are refused outright. Writes use the service role because the
// ledger tables have no client-facing write policies on purpose.
//
// Secrets: REFUND_PIN, STRIPE_SECRET_KEY (payment_link only), APP_URL (same).

import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  appBaseUrl,
  getStripe,
  STRIPE_META,
  stripeErrorMessage,
} from "../_shared/stripe.ts";
import { corsHeaders, db, json, SUPABASE_URL } from "../_shared/sms.ts";
import { requireStaff, type Staff } from "../_shared/staff-auth.ts";

const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REFUND_PIN = Deno.env.get("REFUND_PIN") ?? "";

type Action = "refund_card" | "refund_cash" | "move_sale" | "payment_link";

interface Payload {
  action?: Action;
  id?: string;
  amount_cents?: number;
  pin?: string;
  kind?: "card" | "cash";
  next_source?: string;
}

/**
 * Constant-time compare, so a wrong passcode cannot be narrowed one character at
 * a time by timing the response. Deno has no node:crypto timingSafeEqual here, so
 * this is the same idea written out: always walk the whole string.
 */
function pinMatches(input: string, expected: string): boolean {
  if (input.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < input.length; i++) {
    diff |= input.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function checkPin(pin: string | undefined): string | null {
  if (!REFUND_PIN) return "This is locked: REFUND_PIN is not set.";
  if (!pin || !pinMatches(pin, REFUND_PIN)) return "Wrong passcode.";
  return null;
}

/** Owner, or the manager of the business the row belongs to. */
function ownsBusiness(staff: Staff, businessId: string | null): boolean {
  if (staff.role === "owner") return true;
  return (
    staff.role === "business_manager" &&
    staff.business_id != null &&
    staff.business_id === businessId
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Validate a refund amount against the balance recomputed from the DB row. */
function refundableError(
  amountCents: number | undefined,
  total: number,
  already: number,
): { error: string } | { amount: number } {
  if (!Number.isFinite(amountCents) || (amountCents ?? 0) <= 0) {
    return { error: "Enter a refund amount." };
  }
  const remaining = total - already;
  if (remaining <= 0) return { error: "This is already fully refunded." };
  const amount = Math.floor(amountCents!);
  if (amount > remaining) {
    return {
      error:
        `The most you can refund is ${money(remaining)}. Reload the page to see the latest refunds.`,
    };
  }
  return { amount };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const staff = auth.staff;
  if (staff.role === "check_in") return json({ error: "Not authorized." }, 403);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { action, id } = payload;
  if (!action || !id) return json({ error: "action and id are required" }, 400);

  // The passcode gates everything that moves money or moves whose numbers it
  // counts toward. The payment link creates no charge, so it is not gated.
  if (action !== "payment_link") {
    const pinError = checkPin(payload.pin);
    if (pinError) return json({ error: pinError }, 403);
  }

  switch (action) {
    /**
     * Refund a recorded Stripe charge, full or partial.
     *
     * The refund is created on the account the charge actually settled on, not
     * the business's current one: direct charges live on the connected account,
     * and a business that has switched accounts still has to refund from the old
     * one. The webhook (charge.refunded) reconciles totals afterwards; we also
     * update them here so the screen reflects the refund immediately.
     */
    case "refund_card": {
      const stripe = getStripe();
      if (!stripe) return json({ error: "Payments are not configured yet." }, 503);

      const { data: txn } = await db
        .from("stripe_transactions")
        .select(
          "id, stripe_id, object_type, connected_account_id, business_id, amount, amount_refunded, currency, booking_id, status",
        )
        .eq("id", id)
        .maybeSingle();
      if (!txn) return json({ error: "Transaction not found." }, 404);
      if (!ownsBusiness(staff, txn.business_id)) {
        return json({ error: "Not authorized." }, 403);
      }
      if (txn.object_type !== "charge") {
        return json({ error: "Only card charges can be refunded here." }, 400);
      }

      const checked = refundableError(
        payload.amount_cents,
        txn.amount ?? 0,
        txn.amount_refunded ?? 0,
      );
      if ("error" in checked) return json(checked, 400);

      try {
        const refund = await stripe.refunds.create(
          { charge: txn.stripe_id, amount: checked.amount },
          txn.connected_account_id
            ? { stripeAccount: txn.connected_account_id }
            : undefined,
        );

        await db.from("stripe_refunds").insert({
          stripe_refund_id: refund.id,
          transaction_id: txn.id,
          business_id: txn.business_id,
          booking_id: txn.booking_id,
          amount: refund.amount ?? checked.amount,
          currency: txn.currency ?? "usd",
          status: refund.status ?? null,
          reason: refund.reason ?? null,
          created_by_staff_id: staff.id,
          raw: refund,
        });

        const newRefunded = (txn.amount_refunded ?? 0) + (refund.amount ?? checked.amount);
        await db
          .from("stripe_transactions")
          .update({
            amount_refunded: newRefunded,
            status: newRefunded >= (txn.amount ?? 0) ? "refunded" : txn.status,
          })
          .eq("id", txn.id);

        return json({ ok: true });
      } catch (err) {
        // Stripe's wording carries charge ids and API terms, so it stays in the
        // log and the manager gets one line they can act on.
        console.error("[payments] card refund failed:", err);
        return json({ error: "The refund did not go through. Try again, or check Stripe." }, 502);
      }
    }

    /**
     * Refund a cash sale. Nothing to call Stripe about: the money leaves the
     * drawer by hand, so this records what was handed back and the ledger follows.
     */
    case "refund_cash": {
      const { data: sale } = await db
        .from("cash_sales")
        .select("id, business_id, amount_cents, amount_refunded_cents")
        .eq("id", id)
        .maybeSingle();
      if (!sale) return json({ error: "Sale not found." }, 404);
      if (!ownsBusiness(staff, sale.business_id)) {
        return json({ error: "Not authorized." }, 403);
      }

      const already = sale.amount_refunded_cents ?? 0;
      const checked = refundableError(payload.amount_cents, sale.amount_cents ?? 0, already);
      if ("error" in checked) return json(checked, 400);

      const { error } = await db
        .from("cash_sales")
        .update({
          amount_refunded_cents: already + checked.amount,
          refunded_at: new Date().toISOString(),
          refunded_by: staff.id,
        })
        .eq("id", id);
      if (error) {
        console.error("[payments] cash refund failed:", error);
        return json({ error: "Could not record the refund. Try again." }, 500);
      }
      return json({ ok: true });
    }

    /**
     * Move a sale to a different kiosk. No money moves, but it shifts revenue
     * between kiosks, which is what staff are measured on, so it is passcode-gated
     * like a refund. The first move records where the sale actually came from;
     * later moves keep that original, so the trail always points at what the
     * tablet reported.
     */
    case "move_sale": {
      const target = (payload.next_source ?? "").trim();
      if (!/^[a-z0-9_-]{1,32}$/i.test(target)) return json({ error: "Pick a kiosk." }, 400);
      const movedAt = new Date().toISOString();

      // The kiosk lives in a different column per table, so the two cases are
      // written out rather than built from variables.
      if (payload.kind === "cash") {
        const { data: sale } = await db
          .from("cash_sales")
          .select("id, business_id, kiosk_slug, kiosk_slug_original, source_moved_at")
          .eq("id", id)
          .maybeSingle();
        if (!sale) return json({ error: "Sale not found." }, 404);
        if (!ownsBusiness(staff, sale.business_id)) {
          return json({ error: "Not authorized." }, 403);
        }
        if (sale.kiosk_slug === target) return json({ ok: true });

        const { error } = await db
          .from("cash_sales")
          .update({
            kiosk_slug: target,
            kiosk_slug_original: sale.source_moved_at ? sale.kiosk_slug_original : sale.kiosk_slug,
            source_moved_at: movedAt,
            source_moved_by: staff.id,
          })
          .eq("id", id);
        if (error) {
          console.error("[payments] move sale failed:", error);
          return json({ error: "Could not move the sale. Try again." }, 500);
        }
        return json({ ok: true });
      }

      const { data: sale } = await db
        .from("stripe_transactions")
        .select("id, business_id, source, source_original, source_moved_at")
        .eq("id", id)
        .maybeSingle();
      if (!sale) return json({ error: "Sale not found." }, 404);
      if (!ownsBusiness(staff, sale.business_id)) {
        return json({ error: "Not authorized." }, 403);
      }
      if (sale.source === target) return json({ ok: true });

      const { error } = await db
        .from("stripe_transactions")
        .update({
          source: target,
          source_original: sale.source_moved_at ? sale.source_original : sale.source,
          source_moved_at: movedAt,
          source_moved_by: staff.id,
        })
        .eq("id", id);
      if (error) {
        console.error("[payments] move sale failed:", error);
        return json({ error: "Could not move the sale. Try again." }, 500);
      }
      return json({ ok: true });
    }

    /**
     * A Stripe Checkout link a staffer can send a customer to pay for a booking.
     *
     * The booking is read with the CALLER's token so RLS scopes it: a manager can
     * only mint a link for a booking they can already see. The connected account
     * is a privileged field, so that read uses the service role, but only after
     * RLS has authorized the caller for this booking. Direct charge on the
     * business's account with the platform application fee, same as /gp. The
     * booking flips to paid when the webhook fires; nothing is written here.
     */
    case "payment_link": {
      const stripe = getStripe();
      const base = appBaseUrl();
      if (!stripe || !base) return json({ error: "Payments are not configured yet." }, 503);

      const scoped = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: req.headers.get("Authorization")! } },
      });
      const { data: booking } = await scoped
        .from("bookings")
        .select(
          "id, business_id, total_cents, status, public_token, customer:customers(email), business_tour:business_tours(name)",
        )
        .eq("id", id)
        .maybeSingle();
      if (!booking) return json({ error: "Booking not found" }, 404);
      if (booking.status === "cancelled") {
        return json({ error: "This booking is cancelled." }, 400);
      }

      const amount = booking.total_cents ?? 0;
      if (amount <= 0) return json({ error: "This booking has no amount to charge." }, 400);

      const { data: biz } = await db
        .from("businesses")
        .select("stripe_account_id, stripe_charges_enabled")
        .eq("id", booking.business_id)
        .maybeSingle();
      if (!biz?.stripe_account_id || !biz.stripe_charges_enabled) {
        return json({ error: "This business cannot accept card payments yet." }, 409);
      }

      const metadata = {
        [STRIPE_META.bookingId]: booking.id,
        [STRIPE_META.source]: "online",
        [STRIPE_META.businessId]: booking.business_id,
      };
      const dest = booking.public_token ? `${base}/booking/${booking.public_token}` : base;
      const email = (booking.customer as { email?: string } | null)?.email;
      const tourName = (booking.business_tour as { name?: string } | null)?.name ?? "Booking";

      // The platform fee is read from the same env the webhook uses, so one
      // number governs every charge the app creates.
      const bps = Number(Deno.env.get("STRIPE_PLATFORM_FEE_BPS") ?? "25");
      const rate = Number.isFinite(bps) && bps >= 0 && bps <= 10000 ? Math.floor(bps) : 25;
      const fee = Math.max(0, Math.min(Math.floor((amount * rate) / 10000), amount - 1));

      try {
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          ...(email ? { customer_email: email } : {}),
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: tourName },
                unit_amount: amount,
              },
              quantity: 1,
            },
          ],
          payment_intent_data: {
            ...(fee > 0 ? { application_fee_amount: fee } : {}),
            metadata,
          },
          metadata,
          success_url: `${dest}?payment=success`,
          cancel_url: `${dest}?payment=cancelled`,
        }, { stripeAccount: biz.stripe_account_id });

        if (!session.url) return json({ error: "Stripe did not return a link." }, 502);
        return json({ url: session.url });
      } catch (err) {
        console.error("[payments] payment link failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
    }

    default:
      return json({ error: "Unknown action" }, 400);
  }
});
