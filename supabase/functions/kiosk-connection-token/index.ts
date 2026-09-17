// Stripe Terminal connection token for the PrimeKiosk tablet. Supabase-native
// replacement for the Xano `connection-token_v6` endpoint. Runs entirely on
// Supabase (no Vercel hop): resolves the kiosk's connected account from the DB
// with the service role, then mints a Terminal connection token ON that account.
//
// Public like the Xano endpoint (deployed with JWT off) so the tablet needs no
// Supabase session. Optional hardening: if KIOSK_SHARED_SECRET is set, the caller
// must send header `x-kiosk-secret: <that value>`.
//
// Body: { kiosk }          (kiosks.slug — the tablet's login username in the app)
// Response (Xano's shape): { secret, location, account, simulated }
//
// Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key). SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const KIOSK_SHARED_SECRET = Deno.env.get("KIOSK_SHARED_SECRET") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
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

  return {
    account,
    location: (kiosk.terminal_location_id as string | null) ?? null,
    simulated: (kiosk.simulated as boolean | null) ?? false,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (KIOSK_SHARED_SECRET && req.headers.get("x-kiosk-secret") !== KIOSK_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!STRIPE_SECRET_KEY) return json({ error: "not_configured" }, 503);

  let body: { kiosk?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const kiosk = String(body.kiosk ?? "").trim();
  if (!kiosk) return json({ error: "missing_kiosk" }, 400);

  const resolved = await resolveKioskAccount(kiosk);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);

  // Create the token ON the connected account. Location is not passed to the
  // create call (matching Xano); it is returned so the tablet can scope readers.
  const res = await fetch("https://api.stripe.com/v1/terminal/connection_tokens", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Account": resolved.account,
    },
  });
  const data = await res.json();
  if (!res.ok || !data?.secret) {
    return json({ error: "stripe_error", message: data?.error?.message ?? null }, 502);
  }

  return json(
    {
      secret: data.secret,
      location: resolved.location,
      account: resolved.account,
      simulated: resolved.simulated,
    },
    200,
  );
});
