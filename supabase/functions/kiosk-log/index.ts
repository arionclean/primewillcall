// Event intake for the PrimeKiosk tablets (kiosk card flow v2).
//
// The tablet batches what it sees (reader connected, dropped, low battery, sale
// started, card result with the SDK's error text, receipt printed, app launched)
// and posts them here; they land in kiosk_events, keyed by kiosk and, when the
// event belongs to a sale, by the KS code. That is the stream that answers "what
// happened on kiosk3 at 6:11 PM" months later, which neither Supabase's own edge
// logs (days) nor Xano's request history (about a day) can.
//
// Best-effort by design: the tablet never waits on this, and a bad event is dropped,
// not rejected with the batch.
//
// Body: { kiosk, app_build?, device_id?, events: [{ event, level?, ref?, payload?, at? }] }

import { json, kioskAuthorized, resolveEmployee, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_EVENTS = 100;

interface IncomingEvent {
  event?: string;
  level?: string;
  ref?: string | null;
  payload?: unknown;
  at?: string | number | null;
  employee_id?: string | null;
  employee_name?: string | null;
}

function clientAt(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

Deno.serve(withSentry("kiosk-log", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: {
    kiosk?: string;
    app_build?: string;
    device_id?: string;
    employee_id?: string;
    employee_name?: string;
    events?: IncomingEvent[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  if (events.length === 0) return json({ ok: true, inserted: 0 }, 200);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk } = resolved;

  // Employees are checked once per distinct id in the batch; an id that does not
  // check out keeps the name the tablet sent (a log, not a permission), no id.
  const cache = new Map<string, string | null>();
  const employeeIdFor = async (raw: unknown): Promise<string | null> => {
    const id = String(raw ?? "").trim();
    if (!id) return null;
    if (!cache.has(id)) cache.set(id, (await resolveEmployee(sb, id))?.id ?? null);
    return cache.get(id) ?? null;
  };

  const rows = [];
  for (const e of events) {
    const name = String(e?.event ?? "").trim().slice(0, 64);
    if (!name) continue;
    const level = LEVELS.has(String(e.level)) ? String(e.level) : "info";
    const ref = e.ref ? String(e.ref).trim().toUpperCase().slice(0, 32) : null;
    const payload = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {};
    rows.push({
      kiosk_id: kiosk.id,
      kiosk_slug: kiosk.slug,
      business_id: kiosk.business_id,
      ref,
      event: name,
      level,
      payload,
      app_build: body.app_build ?? null,
      device_id: body.device_id ?? null,
      client_at: clientAt(e.at),
      employee_id: await employeeIdFor(e.employee_id ?? body.employee_id),
      employee_name: String(e.employee_name ?? body.employee_name ?? "").trim().slice(0, 80) || null,
    });
  }
  if (rows.length === 0) return json({ ok: true, inserted: 0 }, 200);

  const { error } = await sb.from("kiosk_events").insert(rows);
  if (error) return json({ error: "insert_failed", message: error.message }, 500);
  return json({ ok: true, inserted: rows.length }, 200);
}));
