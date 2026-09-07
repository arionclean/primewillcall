// Employee PIN check for the PrimeKiosk tablet.
//
// The tablet sends the 4 digits typed on its lock screen; we answer with the employee
// (id + name) they belong to, or a failure. PINs are stored hashed (see
// _shared/kiosk-pin.ts) and are unique among the active employees of a business, so a
// PIN alone identifies the person on that business's kiosks.
//
// Brute force is bounded per kiosk: after 5 wrong PINs within a minute the kiosk is
// refused for the rest of that minute ("locked"). Every attempt, good or bad, is an
// event in kiosk_events, so a run of failures is visible to the owner.
//
// Body: { kiosk, pin, app_build?, device_id? }
// 200 { ok, employee: { id, name }, idle_lock_seconds } | 401 bad_pin | 429 locked

import { hashPin, PIN_RE } from "../_shared/kiosk-pin.ts";
import { json, kioskAuthorized, logEvent, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";

const MAX_FAILURES_PER_MINUTE = 5;

interface EmployeeRow {
  id: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
  kiosk_ids: string[] | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: { kiosk?: string; pin?: string; app_build?: string; device_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  const pin = String(body.pin ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  if (!PIN_RE.test(pin)) return json({ error: "bad_pin" }, 401);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk } = resolved;
  if (!kiosk.business_id) return json({ error: "kiosk_without_business" }, 409);

  const meta = {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    appBuild: body.app_build ?? null,
    deviceId: body.device_id ?? null,
  };

  // Per-kiosk attempt limit.
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await sb
    .from("kiosk_events")
    .select("id", { count: "exact", head: true })
    .eq("kiosk_id", kiosk.id)
    .eq("event", "pin_failed")
    .gte("at", since);
  if ((count ?? 0) >= MAX_FAILURES_PER_MINUTE) {
    await logEvent(sb, { ...meta, event: "pin_locked", level: "warn" });
    return json({ error: "locked", retry_in_seconds: 60 }, 429);
  }

  const { data: employees } = await sb
    .from("kiosk_employees")
    .select("id, name, pin_hash, pin_salt, kiosk_ids")
    .eq("business_id", kiosk.business_id)
    .eq("is_active", true)
    .returns<EmployeeRow[]>();

  let match: EmployeeRow | null = null;
  for (const e of employees ?? []) {
    if (e.kiosk_ids && e.kiosk_ids.length > 0 && !e.kiosk_ids.includes(kiosk.id)) continue;
    if ((await hashPin(e.pin_salt, kiosk.business_id, pin)) === e.pin_hash) {
      match = e;
      break;
    }
  }

  if (!match) {
    await logEvent(sb, { ...meta, event: "pin_failed", level: "warn" });
    return json({ error: "bad_pin" }, 401);
  }

  await sb
    .from("kiosk_employees")
    .update({ last_seen_at: new Date().toISOString(), last_seen_kiosk: kiosk.slug })
    .eq("id", match.id);
  await logEvent(sb, { ...meta, event: "pin_ok", employeeId: match.id, employeeName: match.name });

  return json(
    {
      ok: true,
      employee: { id: match.id, name: match.name },
      idle_lock_seconds: kiosk.pin_idle_lock_seconds,
    },
    200,
  );
});
