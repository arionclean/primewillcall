// The two booking edits a tablet makes on an existing booking: check a guest in (or
// undo it) and mark a balance as paid at the desk.
//
// Until now both went to Xano only, and reached this platform because Xano's trigger
// echoed them back through xano-booking-sync. That works exactly as long as Xano is
// in the loop. The moment a tablet stops writing to Xano, a check-in made on it would
// land nowhere. This is the direct write, the same shape as kiosk-booking and
// kiosk-cash-sale: the tablet sends it right after (not instead of) its Xano call.
//
// Two rules keep the two copies from fighting:
//   - The write goes out under x-sync-origin: mirror (serviceClient), so the mirror
//     queue does not send it to Xano a second time. The tablet already did.
//   - Xano's echo of the same change arrives moments later and sets the same value,
//     which is a no-op. Nothing here depends on which of the two lands first.
//
// The tablet identifies the booking by what Xano gave it: the numeric Xano row id and
// the internal code (KS-... for its own sales, PW-... for the rest). The row id wins
// when we hold it. The code alone is not enough on its own: Xano reuses PW codes
// (PW-25335 is two different people), so a code match is narrowed by the tour date.
//
// Public like the other kiosk functions (JWT off); optional KIOSK_SHARED_SECRET.
// Body: { kiosk, action: 'check_in' | 'mark_paid', booking_id?, booking_ref?,
//         date?, checked?, employee_id?, app_build?, device_id? }

import {
  json,
  kioskAuthorized,
  resolveEmployee,
  resolveKiosk,
  serviceClient,
} from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

type Action = "check_in" | "mark_paid";

interface Body {
  kiosk?: string;
  action?: Action;
  booking_id?: string | number;
  booking_ref?: string;
  date?: string;
  checked?: boolean;
  employee_id?: string;
  app_build?: string;
  device_id?: string;
}

interface BookingRow {
  id: string;
  checked_in_at: string | null;
  due_cents: number;
  paid_at: string | null;
  starts_at: string;
}

const COLS = "id, checked_in_at, due_cents, paid_at, starts_at";

/** The booking a tablet means. Row id first; else the code, narrowed by date. */
async function findBooking(
  sb: ReturnType<typeof serviceClient>,
  body: Body,
): Promise<BookingRow | null> {
  const numeric = String(body.booking_id ?? "").trim();
  if (/^\d+$/.test(numeric)) {
    const { data } = await sb
      .from("bookings")
      .select(COLS)
      .eq("xano_booking_id", Number(numeric))
      .maybeSingle<BookingRow>();
    if (data) return data;
  }

  const ref = String(body.booking_ref ?? "").trim();
  if (!ref) return null;
  const { data: rows } = await sb
    .from("bookings")
    .select(COLS)
    .or(`xano_internal_id.eq.${ref},legacy_id.eq.${ref}`)
    .neq("status", "cancelled")
    .limit(10)
    .returns<BookingRow[]>();
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  // Several rows share the code. The tablet sends the tour date it is looking at;
  // the row on that day is the one. Compared in New York, which is what "the day"
  // means to the desk.
  const day = String(body.date ?? "").trim();
  if (day) {
    const onDay = rows.filter((r) =>
      new Date(r.starts_at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === day
    );
    if (onDay.length === 1) return onDay[0];
  }
  return null;
}

Deno.serve(withSentry("kiosk-booking-update", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  const action = body.action;
  if (action !== "check_in" && action !== "mark_paid") return json({ error: "bad_action" }, 400);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);

  const booking = await findBooking(sb, body);
  if (!booking) return json({ error: "booking_not_found" }, 404);

  // Attribution only. A wrong or stale employee never blocks the edit.
  const employee = await resolveEmployee(sb, body.employee_id);
  const now = new Date().toISOString();

  let patch: Record<string, unknown>;
  if (action === "check_in") {
    const checked = body.checked !== false;
    patch = {
      // Idempotent: checking in twice keeps the first time, so the two copies
      // (this write and Xano's echo) cannot bounce the timestamp around.
      checked_in_at: checked ? (booking.checked_in_at ?? now) : null,
      ...(employee ? { kiosk_employee_id: employee.id } : {}),
    };
  } else {
    // The desk collected what the guest still owed. The tablet has already
    // recorded the money itself (kiosk-cash-sale); this only closes the balance.
    patch = {
      due_cents: 0,
      paid_at: booking.paid_at ?? now,
      ...(employee ? { kiosk_employee_id: employee.id } : {}),
    };
  }

  const { error } = await sb.from("bookings").update(patch).eq("id", booking.id);
  if (error) return json({ error: "update_failed", message: error.message }, 500);
  return json({ ok: true, booking_id: booking.id }, 200);
}));
