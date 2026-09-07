// Kiosk booking write for the PrimeKiosk tablet (Xano -> Supabase booking dual-write).
//
// Public entry point the tablet calls (in `dual` / `supabase` mode) to write a booking into
// Supabase. It forwards the booking record to the existing `xano-booking-sync` function
// SERVER-TO-SERVER (adding the shared secret from this function's own env), so the exact same,
// already-proven ingest runs: it upserts the booking on legacy_id and the customer on dedup_key,
// converging with the automatic Xano sync instead of duplicating. No logic is duplicated here.
//
// This keeps XANO_WEBHOOK_SECRET server-side (never shipped in the app). The tablet
// authenticates with the optional KIOSK_SHARED_SECRET header, like the other kiosk functions.
//
// Body: a booking record (or array), the same shape xano-booking-sync accepts, plus an
// optional top-level `employee_id` (the kiosk employee who made it, stamped on
// bookings.kiosk_employee_id after the ingest; the sync itself never sees it). In `dual`
// mode the app posts the Xano booking RESPONSE. At cutover (Xano off) it posts a record
// carrying its own id as `unique_id`, which the sync uses as legacy_id (no Xano needed).
//
// Secrets: XANO_WEBHOOK_SECRET (to call the sync; same value as on xano-booking-sync), optional
// KIOSK_SHARED_SECRET. SUPABASE_URL is provided by the platform.

import { resolveEmployee, serviceClient } from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const WEBHOOK_SECRET = Deno.env.get("XANO_WEBHOOK_SECRET") ?? "";
const KIOSK_SHARED_SECRET = Deno.env.get("KIOSK_SHARED_SECRET") ?? "";
const SYNC_URL = `${SUPABASE_URL}/functions/v1/xano-booking-sync`;

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Make this path compute the SAME legacy_id as Xano's own trigger-driven sync.
 *
 * Xano's `sync booking to supabase_v1` normalizes the record before POSTing, mapping
 * unique_id = unique_id || internal_id. xano-booking-sync then keys legacy_id on
 * booking_reference || unique_id || `xano-<id>`. The tablet forwards the RAW Xano response,
 * where unique_id is empty, so without this it keys on `xano-<id>` while the trigger keys on the
 * internal_id: two different keys, and the upsert cannot converge, leaving a DUPLICATE booking
 * row. Applying the same mapping here makes both writers land on one row.
 */
function normalizeKey(rec: Record<string, unknown>): Record<string, unknown> {
  if (!rec || typeof rec !== "object") return rec;
  const uniqueId = String(rec.unique_id ?? "").trim();
  if (uniqueId) return rec;
  const internalId = String(rec.internal_id ?? "").trim();
  return internalId ? { ...rec, unique_id: internalId } : rec;
}

/** Pull the employee off a record so the sync never sees a field it does not know. */
function stripEmployee(rec: Record<string, unknown>): { rec: Record<string, unknown>; employeeId: string | null } {
  if (!rec || typeof rec !== "object") return { rec, employeeId: null };
  const { employee_id, ...rest } = rec;
  return { rec: rest, employeeId: employee_id ? String(employee_id) : null };
}

Deno.serve(withSentry("kiosk-booking", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (KIOSK_SHARED_SECRET && req.headers.get("x-kiosk-secret") !== KIOSK_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!WEBHOOK_SECRET) return json({ error: "not_configured" }, 503);

  const raw = await req.text();
  if (!raw || !raw.trim()) return json({ error: "empty body" }, 400);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  let employeeId: string | null = null;
  const normalized = list.map((r) => {
    const { rec, employeeId: e } = stripEmployee(r as Record<string, unknown>);
    if (e) employeeId = e;
    return normalizeKey(rec);
  });

  try {
    // Forward to the sync with its shared secret (kept server-side, never in the app).
    const r = await fetch(SYNC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": WEBHOOK_SECRET },
      body: JSON.stringify(Array.isArray(parsed) ? normalized : normalized[0]),
    });
    const data = await r.json().catch(() => ({}));

    // Attribution: stamp the employee on the rows the sync just wrote. Best-effort, and
    // only where no one is recorded yet, so a later resend cannot rewrite history.
    if (r.ok && employeeId) {
      const sb = serviceClient();
      const keys = (Array.isArray(data?.results) ? data.results : [])
        .filter((x: { ok?: boolean; legacy_id?: string | null }) => x?.ok && x.legacy_id)
        .map((x: { legacy_id: string }) => x.legacy_id);
      if (keys.length > 0) {
        const employee = await resolveEmployee(sb, employeeId);
        if (employee) {
          await sb
            .from("bookings")
            .update({ kiosk_employee_id: employee.id })
            .in("legacy_id", keys)
            .is("kiosk_employee_id", null);
        }
      }
    }
    return json(data, r.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync_call_failed";
    return json({ error: "sync_error", message }, 502);
  }
}));
