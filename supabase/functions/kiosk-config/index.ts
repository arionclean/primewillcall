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

/** The only regions a tablet may be told to pin its payment calls to. */
const EDGE_REGIONS = new Set(["us-west-2"]);

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

  // The faster-sale switches, read with their own query and defaulted to today's
  // behaviour on any failure, so a column problem can never take the config down.
  // Nothing new ever goes into resolveKiosk's select: it feeds thirteen functions.
  // edge_region is allow-listed here as well as in the database, because a tablet
  // will pin its payment calls to whatever string it is handed.
  let edgeRegion: string | null = null;
  let saleSettle: "inline" | "deferred" = "inline";
  try {
    const { data: sw } = await sb
      .from("kiosks")
      .select("edge_region, sale_settle")
      .eq("id", kiosk.id)
      .maybeSingle<{ edge_region: string | null; sale_settle: string | null }>();
    if (sw?.edge_region && EDGE_REGIONS.has(sw.edge_region)) edgeRegion = sw.edge_region;
    if (sw?.sale_settle === "deferred") saleSettle = "deferred";
  } catch {
    // defaults
  }

  // When the kiosk asks for a PIN, the eligible employees ride along (id, name,
  // salted hash) so the tablet can check a PIN on the spot and unlock at once;
  // kiosk-pin-verify then confirms it in the background and records the event.
  // A PIN is attribution on a trusted device, not a secret guarding money, which
  // is why the hashes may live on the tablet.
  // Employees are one pool shared by every business, so every active one rides along.
  type EmployeeRow = { id: string; name: string; pin_hash: string; pin_salt: string };
  let employees: EmployeeRow[] = [];
  if (kiosk.pin_required || kiosk.pin_on_sale) {
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
      pin_on_sale: kiosk.pin_on_sale,
      // Where this tablet reads products, bookings and sales from. 'xano' until the
      // owner flips it; an older build never reads the field and keeps reading Xano.
      read_source: kiosk.read_source === "supabase" ? "supabase" : "xano",
      // Where this tablet runs its two payment calls (null = platform default) and
      // whether a paid sale may be settled after the reply. Both are per-kiosk
      // switches; an older build never reads either and keeps today's behaviour.
      edge_region: edgeRegion,
      sale_settle: saleSettle,
      business_id: kiosk.business_id,
      employees,
      xano_mirror: xanoMirrorEnabled(),
      server_time: new Date().toISOString(),
    },
    200,
  );
}));
