// Stripe Terminal PaymentIntent for the PrimeKiosk tablet. Supabase-native
// replacement for the Xano `payment-intent_v2` endpoint. Runs entirely on
// Supabase (no Vercel hop). Creates the intent as a DIRECT charge on the kiosk's
// connected account with the platform application fee, exactly like Xano
// (card_present, automatic capture). The resulting charge records itself into
// stripe_transactions (source='kiosk') via the Stripe webhook, so nothing is
// written here.
//
// Public like the Xano endpoint (JWT off). Optional hardening: if
// KIOSK_SHARED_SECRET is set, the caller must send `x-kiosk-secret: <value>`.
//
// Body: { kiosk, amount, application_fee_amount?, booking_id?, idempotency_key? }
//   amount / application_fee_amount are integer cents.
// Response (Xano's shape): { payment_intent (= client_secret), id, account,
//   amount, application_fee_amount }
//
// Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key), STRIPE_PLATFORM_FEE_BPS
// (optional, default 25 = 0.25%). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
// provided by the platform.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const KIOSK_SHARED_SECRET = Deno.env.get("KIOSK_SHARED_SECRET") ?? "";
const PLATFORM_FEE_BPS = Number(Deno.env.get("STRIPE_PLATFORM_FEE_BPS") ?? "25");

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Platform fee (cents): global rate, floored, clamped below the amount. */
function computeApplicationFeeCents(amount: number): number {
  const bps = Number.isFinite(PLATFORM_FEE_BPS) ? PLATFORM_FEE_BPS : 25;
  const fee = Math.floor((amount * bps) / 10000);
  if (fee <= 0) return 0;
  return Math.min(fee, amount - 1);
}

/**
 * Resolve the tablet's `kiosk` tag (kiosks.slug) to the connected account its
 * sales settle on: the per-kiosk override when set, otherwise the kiosk's
 * business's account. Returns null when unknown or no account can be resolved.
 */
async function resolveKioskAccount(slug: string) {
  const { data: kiosk } = await sb
    .from("kiosks")
    .select("id, business_id, stripe_account_id, terminal_location_id, simulated")
    .eq("slug", slug)
    .maybeSingle();
  if (!kiosk) return null;

  let account: string | null = kiosk.stripe_account_id ?? null;
  if (!account && kiosk.business_id) {
    const { data: biz } = await sb
      .from("businesses")
      .select("stripe_account_id")
      .eq("id", kiosk.business_id)
      .maybeSingle();
    account = biz?.stripe_account_id ?? null;
  }
  if (!account) return null;

  return { businessId: (kiosk.business_id as string | null) ?? null, account };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (KIOSK_SHARED_SECRET && req.headers.get("x-kiosk-secret") !== KIOSK_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!STRIPE_SECRET_KEY) return json({ error: "not_configured" }, 503);

  let body: {
    kiosk?: string;
    amount?: number;
    application_fee_amount?: number;
    booking_id?: string;
    idempotency_key?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const kiosk = String(body.kiosk ?? "").trim();
  const amount = Math.floor(Number(body.amount) || 0);
  if (!kiosk) return json({ error: "missing_kiosk" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "bad_amount" }, 400);

  const resolved = await resolveKioskAccount(kiosk);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);

  // Platform fee: honor an explicit override, else the global rate. Both clamped
  // below the amount (Stripe rejects a fee >= the charge).
  const override = Math.floor(Number(body.application_fee_amount) || 0);
  const fee = override > 0 ? Math.min(override, amount - 1) : computeApplicationFeeCents(amount);

  const bookingRef = String(body.booking_id ?? "").trim();
  const form: Record<string, string> = {
    amount: String(amount),
    currency: "usd",
    "payment_method_types[]": "card_present",
    capture_method: "automatic",
    "metadata[source]": "kiosk",
    "metadata[kiosk]": kiosk,
    "metadata[app_fee]": String(fee),
  };
  if (fee > 0) form["application_fee_amount"] = String(fee);
  if (bookingRef) form["metadata[booking_id]"] = bookingRef;
  if (resolved.businessId) form["metadata[business_id]"] = resolved.businessId;

  // Stable per-sale key so retries never double-charge (Xano falls back to
  // booking_id when no explicit key is sent).
  const idem = String(body.idempotency_key ?? "").trim() || bookingRef;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Account": resolved.account,
  };
  if (idem) headers["Idempotency-Key"] = idem;

  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data?.client_secret) {
    return json({ error: "stripe_error", message: data?.error?.message ?? null }, 502);
  }

  return json(
    {
      payment_intent: data.client_secret,
      id: data.id,
      account: resolved.account,
      amount,
      application_fee_amount: fee,
    },
    200,
  );
});
