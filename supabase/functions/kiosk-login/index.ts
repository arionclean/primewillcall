// The tablet's sign-in, answered by this platform instead of Xano.
//
// Xano's auth/login took an email and password and handed back a token plus the
// kiosk account: username (the kiosk's slug), unique_id (Xano's id for the
// kiosk), company (Xano's id for the business) and company_name. The tablet keeps
// all four for the session and the token is never sent again. This answers in
// that exact shape, so the tablet's session code changes nothing.
//
// The password is checked by Supabase Auth (the same accounts the web app's
// check-in logins use), never here: this function only forwards the credentials
// to Auth's password grant and reads the answer. On a wrong password it says
// what Xano said, "Invalid Credentials.", because that string is what the tablet
// shows. The account then has to be an active check_in login tied to a kiosk.
//
// While a tablet still writes to Xano, unique_id and company must stay Xano's,
// so they come from kiosks.xano_kiosk_id / xano_company_id (see the migration
// that added them). A kiosk with no Xano ids signs in fine and sends none.
//
// Public like the other kiosk functions (JWT off; there is no token yet). The
// optional KIOSK_SHARED_SECRET applies, as everywhere. Body: { email, password }.

import { createClient } from "jsr:@supabase/supabase-js@2";

import { json, kioskAuthorized, logEvent } from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Body {
  email?: string;
  password?: string;
  app_build?: string;
  device_id?: string;
}

interface StaffRow {
  id: string;
  email: string | null;
  role: string;
  is_active: boolean;
  kiosk_slug: string | null;
  created_at: string;
}

interface KioskRow {
  id: string;
  slug: string;
  business_id: string | null;
  xano_kiosk_id: string | null;
  xano_company_id: string | null;
  business: { name: string; legacy_company_id: string | null } | null;
}

const invalid = () => json({ message: "Invalid Credentials." }, 401);

Deno.serve(withSentry("kiosk-login", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return invalid();

  // 1. The password, checked by Auth. The credentials go nowhere else.
  const grant = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!grant.ok) return invalid();
  const session = await grant.json() as {
    access_token?: string;
    expires_in?: number;
    user?: { id?: string };
  };
  const userId = session.user?.id;
  if (!session.access_token || !userId) return invalid();

  // 2. The account has to be a live check-in login tied to a kiosk.
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: staff } = await sb
    .from("staff")
    .select("id, email, role, is_active, kiosk_slug, created_at")
    .eq("user_id", userId)
    .maybeSingle<StaffRow>();
  if (!staff || !staff.is_active) return invalid();
  if (staff.role !== "check_in") return json({ message: "This login is not a kiosk account." }, 403);
  if (!staff.kiosk_slug) return json({ message: "This login has no kiosk assigned." }, 403);

  const { data: kiosk } = await sb
    .from("kiosks")
    .select("id, slug, business_id, xano_kiosk_id, xano_company_id, business:businesses(name, legacy_company_id)")
    .eq("slug", staff.kiosk_slug)
    .maybeSingle<KioskRow>();
  if (!kiosk) return json({ message: "This login has no kiosk assigned." }, 403);

  await sb.from("kiosks").update({ last_seen_at: new Date().toISOString() }).eq("id", kiosk.id);
  await logEvent(sb, {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    event: "login",
    level: "info",
    payload: { source: "supabase", email },
    appBuild: body.app_build ?? null,
    deviceId: body.device_id ?? null,
  });

  // 3. Xano's shape. `id` was Xano's integer row id and the tablet types it as a
  // number; it never uses it, so a stable number derived from the kiosk is enough.
  //
  // token_expiration is the tablet's session length, nothing more: the token is
  // never sent again, and the tablet signs itself out when this passes. Xano gave
  // seven days; Auth's own token lasts an hour, which would sign the desk out
  // every hour. Keep Xano's seven days.
  const expiresMs = 604_800 * 1000;
  return json(
    {
      authToken: session.access_token,
      user: {
        id: Number.parseInt(kiosk.id.replace(/-/g, "").slice(0, 8), 16),
        created_at: new Date(staff.created_at).getTime(),
        email: staff.email ?? email,
        username: kiosk.slug,
        role: "kiosk",
        unique_id: kiosk.xano_kiosk_id ?? "",
        company: kiosk.xano_company_id ?? kiosk.business?.legacy_company_id ?? "",
        company_name: kiosk.business?.name ?? kiosk.slug,
        products_variation_id: null,
        profile_photo_url: null,
      },
      token_expiration: Date.now() + expiresMs,
    },
    200,
  );
}));
