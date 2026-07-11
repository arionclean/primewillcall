import { NextResponse } from "next/server";

import {
  STRIPE_META,
  appBaseUrl,
  computeApplicationFeeCents,
  getStripeClient,
} from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Create a Stripe Checkout link a staffer can send a customer to pay for a
 * booking. Supabase-native replacement for the Xano create_payment_link /
 * makePayment endpoints.
 *
 * Authorization is by RLS: the booking is read with the caller's server client,
 * so a manager can only mint a link for a booking they can already see (owner:
 * any; check_in is blocked below). The connected-account lookup + charge use the
 * DIRECT-charge model (session on the business's account, platform application
 * fee), identical to the /gp checkout. The booking flips to paid/confirmed when
 * the webhook fires; nothing is written here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("role, is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staff) {
    return NextResponse.json({ error: "No active staff row" }, { status: 403 });
  }
  if (staff.role === "check_in") {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // RLS scopes this read: a manager only sees their own business's bookings.
  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, business_id, total_cents, status, public_token, customer:customers(email), business_tour:business_tours(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.status === "cancelled") {
    return NextResponse.json(
      { error: "This booking is cancelled." },
      { status: 400 },
    );
  }

  const amount = booking.total_cents ?? 0;
  if (amount <= 0) {
    return NextResponse.json(
      { error: "This booking has no amount to charge." },
      { status: 400 },
    );
  }

  const stripe = getStripeClient();
  const base = appBaseUrl();
  if (!stripe || !base) {
    return NextResponse.json(
      { error: "Payments are not configured yet." },
      { status: 503 },
    );
  }

  // The connected account is a privileged field; read it with the service role
  // after RLS has already authorized the caller for this booking.
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Payments are not configured yet." },
      { status: 503 },
    );
  }
  const { data: biz } = await admin
    .from("businesses")
    .select("stripe_account_id, stripe_charges_enabled")
    .eq("id", booking.business_id)
    .maybeSingle();
  if (!biz?.stripe_account_id || !biz.stripe_charges_enabled) {
    return NextResponse.json(
      { error: "This business cannot accept card payments yet." },
      { status: 409 },
    );
  }

  const tourName = booking.business_tour?.name ?? "Booking";
  const email = booking.customer?.email ?? undefined;
  const applicationFee = computeApplicationFeeCents(amount);
  const metadata = {
    [STRIPE_META.bookingId]: booking.id,
    [STRIPE_META.source]: "online",
    [STRIPE_META.businessId]: booking.business_id,
  };
  const dest = booking.public_token
    ? `${base}/booking/${booking.public_token}`
    : base;

  try {
    const session = await stripe.checkout.sessions.create(
      {
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
          ...(applicationFee > 0
            ? { application_fee_amount: applicationFee }
            : {}),
          metadata,
        },
        metadata,
        success_url: `${dest}?payment=success`,
        cancel_url: `${dest}?payment=cancelled`,
      },
      { stripeAccount: biz.stripe_account_id },
    );
    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe did not return a link." },
        { status: 502 },
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
