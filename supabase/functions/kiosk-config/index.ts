// Per-kiosk runtime config for the PrimeKiosk tablet (kiosk card flow v2).
//
// The tablet calls this once at login and whenever it returns to the foreground.
// It answers which card flow this kiosk runs (kiosks.card_flow: 'v1' keeps today's
// behaviour, 'v2' turns on the sale-first flow and its safeguards) and the reader
// battery thresholds. Flipping the column is the rollout switch and the rollback:
// no reinstall, no staff action. An old build never calls this function.
//
// Public like the other kiosk functions (JWT off); optional KIOSK_SHARED_SECRET.
// Body: { kiosk, app_build?, device_id? }   kiosk = kiosks.slug (the login username).

import {
  json,
  kioskAuthorized,
  logEvent,
  resolveKiosk,
  serviceClient,
  xanoMirrorEnabled,
} from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

Deno.serve(withSentry("kiosk-config", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: { kiosk?: string; app_build?: string; device_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk } = resolved;

  // When the kiosk asks for a PIN, the eligible employees ride along (id, name,
  // salted hash) so the tablet can check a PIN on the spot and unlock at once;
  // kiosk-pin-verify then confirms it in the background and records the event.
  // A PIN is attribution on a trusted device, not a secret guarding money, which
  // is why the hashes may live on the tablet.
  // Employees are one pool shared by every business, so every active one rides along.
  type EmployeeRow = { id: string; name: string; pin_hash: string; pin_salt: string };
  let employees: EmployeeRow[] = [];
  if (kiosk.pin_required) {
    const { data } = await sb
      .from("kiosk_employees")
      .select("id, name, pin_hash, pin_salt")
      .eq("is_active", true)
      .returns<EmployeeRow[]>();
    employees = data ?? [];
  }

  await sb.from("kiosks").update({ last_seen_at: new Date().toISOString() }).eq("id", kiosk.id);
  await logEvent(sb, {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    event: "config_fetched",
    level: "debug",
    payload: { card_flow: kiosk.card_flow },
    appBuild: body.app_build ?? null,
    deviceId: body.device_id ?? null,
  });

  return json(
    {
      ok: true,
      kiosk: kiosk.slug,
      card_flow: kiosk.card_flow,
      reader_low_battery_pct: kiosk.reader_low_battery_pct,
      reader_block_battery_pct: kiosk.reader_block_battery_pct,
      pin_required: kiosk.pin_required,
      business_id: kiosk.business_id,
      employees,
      xano_mirror: xanoMirrorEnabled(),
      server_time: new Date().toISOString(),
    },
    200,
  );
}));
