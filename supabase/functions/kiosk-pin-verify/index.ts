// Employee PIN check for the PrimeKiosk tablet.
//
// The tablet sends the 4 digits typed on its lock screen; we answer with the employee
// (id + name) they belong to, or a failure. PINs are stored hashed (see
// _shared/kiosk-pin.ts) and are unique among the active employees of a business, so a
// PIN alone identifies the person on that business's kiosks.
//
// No lockout, by the owner's choice: a wrong PIN just says so and the person tries
// again. Every attempt, good or bad, is an event in kiosk_events, so a run of
// failures is still visible on the Employees page.
//
// Body: { kiosk, pin, app_build?, device_id? }
// 200 { ok, employee: { id, name }, idle_lock_seconds } | 401 bad_pin

import { hashPin, PIN_RE } from "../_shared/kiosk-pin.ts";
import { json, kioskAuthorized, logEvent, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";

interface EmployeeRow {
  id: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
  kiosk_ids: string[] | null;
}

// Runs `work` after the response has been sent. Supabase's runtime keeps the
// isolate alive for a promise handed to EdgeRuntime.waitUntil; without it the
// promise is simply awaited inline, so the function never loses a write.
function afterReply(work: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  const settled = work.catch((e) => console.error("kiosk-pin-verify: deferred write failed", e));
  if (runtime?.waitUntil) runtime.waitUntil(settled);
  else return settled;
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

  // The answer goes back before the bookkeeping writes: the person at the
  // tablet is waiting on this reply, and neither the event nor last_seen_at
  // changes it. `afterReply` keeps the function alive until they finish.
  if (!match) {
    afterReply(logEvent(sb, { ...meta, event: "pin_failed", level: "warn" }));
    return json({ error: "bad_pin" }, 401);
  }

  afterReply(
    Promise.all([
      sb
        .from("kiosk_employees")
        .update({ last_seen_at: new Date().toISOString(), last_seen_kiosk: kiosk.slug })
        .eq("id", match.id),
      logEvent(sb, { ...meta, event: "pin_ok", employeeId: match.id, employeeName: match.name }),
    ]),
  );

  return json(
    {
      ok: true,
      employee: { id: match.id, name: match.name },
      idle_lock_seconds: kiosk.pin_idle_lock_seconds,
    },
    200,
  );
});
