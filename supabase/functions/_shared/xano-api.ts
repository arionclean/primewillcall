/**
 * The Xano booking endpoints this platform writes to or looks bookings up on.
 *
 * Every Xano write in the codebase goes through here (or through kiosk-sale.ts, which
 * posts the tablet's own payload), so the endpoints, the token and the timeout live
 * in one place. None of these throw: a Xano failure comes back as `{ ok: false }`
 * and the caller decides whether to retry.
 *
 * - `xanoCreateBooking`: POST booking/v12 (auth group 57, needs XANO_API_TOKEN). Xano
 *   ADDS OR EDITS by internal_id, so a repeated call with the same internal id is
 *   idempotent. Returns the Xano row, whose `id` is what the PATCH addresses.
 * - `xanoPatchBooking`: PATCH booking/{id} in the Bookings_legacy_fix group, the
 *   partial update the iPad uses for check-ins. No auth. Sends only the given fields.
 * - `xanoGetBookingByInternalId` / `xanoGetBookingByConfirmationId`: GET lookups in
 *   the same group, used to learn a Xano row id we never stored.
 */

export const XANO_BOOKINGS_API = "https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn";
export const XANO_LEGACY_FIX_API = "https://xmhi-aj9d-cnsb.n7.xano.io/api:2k2IsvEZ";
const TIMEOUT_MS = 8_000;

export type XanoResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

export function xanoApiToken(): string {
  return Deno.env.get("XANO_API_TOKEN")?.trim() ?? "";
}

/** The numeric row id off a Xano booking record, or null. */
export function xanoRowId(record: unknown): number | null {
  if (!record || typeof record !== "object") return null;
  const raw = (record as Record<string, unknown>).id;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function request<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<XanoResult<T>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `Xano ${label} ${res.status}: ${text.slice(0, 200)}` };
    }
    const text = await res.text();
    let value: unknown = null;
    if (text.trim()) {
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, error: `Xano ${label}: response is not JSON` };
      }
    }
    return { ok: true, value: value as T };
  } catch (error) {
    return { ok: false, error: `Xano ${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Add or edit a booking by its internal_id. Returns the Xano row. */
export function xanoCreateBooking(
  payload: Record<string, unknown>,
): Promise<XanoResult<Record<string, unknown> | null>> {
  const token = xanoApiToken();
  if (!token) return Promise.resolve({ ok: false, error: "XANO_API_TOKEN is not set" });
  return request(`${XANO_BOOKINGS_API}/booking/v12`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, "booking/v12");
}

/** Partial update of one Xano row by its numeric id. Returns the patched row. */
export function xanoPatchBooking(
  xanoBookingId: number,
  updates: Record<string, unknown>,
): Promise<XanoResult<Record<string, unknown> | null>> {
  return request(`${XANO_LEGACY_FIX_API}/booking/${xanoBookingId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ booking_id: String(xanoBookingId), updates }),
  }, `booking/${xanoBookingId}`);
}

/** The Xano row with this internal_id, or null when Xano has none. */
export function xanoGetBookingByInternalId(
  internalId: string,
): Promise<XanoResult<Record<string, unknown> | null>> {
  const url = `${XANO_LEGACY_FIX_API}/internal_id/booking?booking_internal_id=${encodeURIComponent(internalId)}`;
  return request(url, { method: "GET" }, "internal_id/booking");
}

/** The Xano row with this bookingConfirmation_id (our public_token), or null. */
export function xanoGetBookingByConfirmationId(
  confirmationId: string,
): Promise<XanoResult<Record<string, unknown> | null>> {
  const url = `${XANO_LEGACY_FIX_API}/booking?booking_confirmation_id=${encodeURIComponent(confirmationId)}`;
  return request(url, { method: "GET" }, "booking?confirmation");
}
