// Public Groupon booking creator for the /gp page. Supabase-native replacement for the
// Vercel route src/app/api/gp/book/route.ts.
//
// Runs with the service role and re-validates everything against the database (it never
// trusts the client's fee): resolves the product, checks the slot belongs to the tour and
// is not closed on that date, creates the customer, and writes a `pending` ("waiting for
// payment") booking on the groupon channel. Then it creates a Stripe Checkout Session as
// a DIRECT charge on the business's connected account with the platform application fee.
//
// Deployed with JWT on: the public page sends the publishable anon key.
//
// Secrets: STRIPE_SECRET_KEY (platform key), STRIPE_PLATFORM_FEE_BPS (optional, default 25),
// APP_URL (Stripe redirect base), GP_XANO_MIRROR + XANO_API_TOKEN (optional, see xano-mirror.ts).

import Stripe from "npm:stripe@22.3.0";

import {
  appBaseUrl,
  computeApplicationFeeCents,
  corsHeaders,
  db,
  json,
  STRIPE_META,
} from "../_shared/gp.ts";
import {
  gpMirrorEnabled,
  gpMirrorLegacyId,
  gpMirrorRef,
  mirrorGpBookingToXano,
} from "./xano-mirror.ts";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() })
  : null;

/** The row create_booking() returns. */
interface CreatedBooking {
  booking_id: string;
  public_token: string;
  total_cents: number;
  starts_at: string;
  ends_at: string;
}

interface Body {
  businessTourId?: string;
  customerName?: string;
  phone?: string;
  date?: string;
  slotStart?: string;
  passengers?: number;
  voucherCodes?: string[];
  voucherCode?: string | null; // legacy single-code shape, still accepted
  imageUrls?: string[];
  imageUrl?: string | null; // legacy single-image shape, still accepted
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const businessTourId = String(body.businessTourId ?? "").trim();
  const customerName = String(body.customerName ?? "").trim();
  const phone = String(body.phone ?? "").replace(/\D/g, "") || null;
  const date = String(body.date ?? "").trim();
  const slotStart = String(body.slotStart ?? "").trim().slice(0, 5);
  const passengers = Math.max(1, Math.floor(Number(body.passengers) || 0));
  const voucherCodes = (
    Array.isArray(body.voucherCodes)
      ? body.voucherCodes
      : body.voucherCode
      ? [body.voucherCode]
      : []
  )
    .map((c) => String(c ?? "").trim())
    .filter(Boolean);
  // Every uploaded voucher, not just the last one. Only stored URLs: the page keeps a
  // local blob: preview in the same gallery when vision could not return one, and that
  // would be a dead link the moment the tab closes.
  const imageUrls = (Array.isArray(body.imageUrls) ? body.imageUrls : [])
    .concat(body.imageUrl ? [body.imageUrl] : [])
    .map((u) => String(u ?? "").trim())
    .filter((u) => u.startsWith("http"))
    .filter((u, i, all) => all.indexOf(u) === i);
  const imageUrl = imageUrls[imageUrls.length - 1] ?? null;

  if (!businessTourId || !customerName) {
    return json({ ok: false, error: "missing_fields", message: "Name and product are required." }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(slotStart)) {
    return json({ ok: false, error: "bad_datetime", message: "Pick a valid date and time." }, 400);
  }

  // Authoritative product + fee (never trust the client's fee). The legacy ids and
  // business name ride along for the temporary Xano mirror below.
  const { data: bt } = await db
    .from("business_tours")
    .select(
      "id, name, business_id, tour_id, is_active, groupon_fee_cents, legacy_product_id, business:businesses!business_tours_business_id_fkey(name, legacy_company_id)",
    )
    .eq("id", businessTourId)
    .maybeSingle();
  if (!bt || !bt.is_active || bt.groupon_fee_cents === null) {
    return json({ ok: false, error: "not_available", message: "This product is not accepting Groupon." }, 400);
  }
  const feeCents = bt.groupon_fee_cents as number;

  // One transaction in the database: it re-checks the slot belongs to this tour, that
  // the time is not closed for that date, prices the fee from business_tours (never from
  // the client), and inserts the customer + pending booking together. See
  // supabase/migrations/20260816120000_create_booking_rpc.sql.
  const noteParts = ["Groupon redemption"];
  if (voucherCodes.length) {
    noteParts.push(`code${voucherCodes.length > 1 ? "s" : ""} ${voucherCodes.join(", ")}`);
  }
  if (imageUrl) noteParts.push(`voucher ${imageUrl}`);

  // Reference shared with the temporary Xano mirror, decided before the insert so the
  // matching legacy_id can be stamped on our row a moment later.
  const mirrorRef = gpMirrorEnabled() ? gpMirrorRef() : null;

  const { data: created, error: rpcErr } = await db
    .rpc("create_booking", {
      p_business_tour_id: businessTourId,
      p_date: date,
      p_slot_start: slotStart,
      p_customer_name: customerName,
      p_pricing: "groupon",
      p_passengers: passengers,
      p_customer_phone: phone,
      p_customer_legacy_source: "groupon",
      p_notes: noteParts.join(" · "),
      p_status: "pending",
      p_source_channel: "groupon",
      p_legacy_reference: voucherCodes.join(", ") || null,
      // A guest may only book a departure that is open and active.
      p_respect_closures: true,
      p_active_slots_only: true,
      // What the bookings list renders as the voucher photo.
      p_groupon_voucher_urls: imageUrls,
    })
    .maybeSingle<CreatedBooking>();

  if (rpcErr || !created) {
    const token = rpcErr?.message ?? "";
    if (token.includes("bad_slot") || token.includes("slot_closed")) {
      return json({ ok: false, error: "bad_slot", message: "That time is no longer available." }, 400);
    }
    if (token.includes("tour_not_available") || token.includes("groupon_not_available")) {
      return json({ ok: false, error: "not_available", message: "This product is not accepting Groupon." }, 400);
    }
    console.error("[gp-book] create_booking failed:", token);
    return json(
      { ok: false, error: "server_error", message: "Could not save your reservation. Please try again." },
      500,
    );
  }

  const booking = { id: created.booking_id, public_token: created.public_token };
  const totalCents = created.total_cents;
  const startsAtIso = created.starts_at;

  // Temporary Xano mirror. Never blocks the guest: a failure is logged and the Supabase
  // booking stands.
  if (mirrorRef) {
    // `legacy_id` is stamped HERE, never in the insert above. The automations trigger is
    // `AFTER INSERT ... WHEN (new.legacy_id IS NULL)`, so setting it inline would mark the
    // booking as Xano-synced and silence the very SMS this test exists to exercise.
    await db
      .from("bookings")
      .update({ legacy_id: gpMirrorLegacyId(mirrorRef) })
      .eq("id", booking.id);

    const biz = bt.business as unknown as { name: string; legacy_company_id: string | null } | null;
    const mirror = await mirrorGpBookingToXano({
      ref: mirrorRef,
      // Unpaid until the Stripe webhook says otherwise. Mirroring "confirmed" here is
      // what corrupted the pending state on the way back through xano-booking-sync.
      status: "pending",
      publicToken: booking.public_token,
      legacyCompanyId: biz?.legacy_company_id ?? null,
      legacyProductId: bt.legacy_product_id,
      productName: bt.name,
      supplierName: biz?.name ?? "",
      customerName,
      startsAtIso,
      passengers,
      voucherImageUrls: imageUrls,
      note: noteParts.join(" · "),
    });
    if (!mirror.ok) {
      console.error(`[gp] Xano mirror failed for booking ${booking.id} (${mirrorRef}): ${mirror.error}`);
    }
  }

  // Charge the convenience fee via a Stripe Checkout Session created DIRECTLY on the
  // business's connected account, with a platform application_fee (Prime's cut). The
  // booking stays `pending` until the webhook flips it to `confirmed`.
  //
  // If Stripe is not configured or this business cannot accept charges, fall back to the
  // pre-Stripe behavior: the pending booking is held and staff collect the fee manually.
  const base = appBaseUrl();
  let checkoutUrl: string | null = null;

  // Falling back to manual collection used to be silent, which is the worst way for it to
  // fail. Name the reason in the log every time.
  if (!stripe) {
    console.error("[gp] Stripe skipped: STRIPE_SECRET_KEY is not set");
  } else if (!base) {
    console.error("[gp] Stripe skipped: APP_URL is not set");
  }

  if (stripe && base) {
    const { data: biz } = await db
      .from("businesses")
      .select("stripe_account_id, stripe_charges_enabled")
      .eq("id", bt.business_id)
      .maybeSingle();

    if (!biz?.stripe_account_id || !biz.stripe_charges_enabled) {
      console.error(
        `[gp] Stripe skipped: business ${bt.business_id} is not onboarded ` +
          `(account=${biz?.stripe_account_id ?? "none"}, charges=${biz?.stripe_charges_enabled ?? false})`,
      );
    }

    if (biz?.stripe_account_id && biz.stripe_charges_enabled) {
      const applicationFee = computeApplicationFeeCents(totalCents);
      const metadata = {
        [STRIPE_META.bookingId]: booking.id,
        [STRIPE_META.source]: "groupon",
        [STRIPE_META.businessId]: bt.business_id,
      };
      try {
        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: { name: `Groupon convenience fee (${bt.name})` },
                  unit_amount: feeCents,
                },
                quantity: passengers,
              },
            ],
            payment_intent_data: {
              // Prime's cut. Omit when zero (Stripe rejects a 0 application fee).
              ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),
              metadata,
            },
            metadata,
            success_url: `${base}/gp/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${base}/gp?checkout=cancelled`,
          },
          { stripeAccount: biz.stripe_account_id },
        );
        checkoutUrl = session.url;
      } catch (e) {
        // Fall through to the manual-collection fallback. Stripe rejects a total under
        // $0.50, which is what a $0 Groupon product produces, so this is a reachable path
        // and not only an outage.
        console.error(
          `[gp] Stripe checkout failed for booking ${booking.id} ` +
            `(${totalCents} cents on ${biz.stripe_account_id}): ${e instanceof Error ? e.message : String(e)}`,
        );
        checkoutUrl = null;
      }
    }
  }

  return json({
    ok: true,
    bookingId: booking.id,
    feeCents,
    passengers,
    totalCents,
    payment: checkoutUrl
      ? { status: "pending", checkoutUrl }
      // Fallback: booking held as pending; fee collected manually (pre-Stripe UX).
      : { status: "stubbed", checkoutUrl: null },
  });
});
