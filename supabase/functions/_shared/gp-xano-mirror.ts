/**
 * Temporary double-write of a public /gp booking into Xano.
 *
 * While /gp is the test bed for the Supabase messaging automations, Supabase is the
 * one sending the SMS. Xano still needs the booking though, so that a failure in the
 * new stack does not leave staff with a guest who booked and no record on the side
 * they actually work from.
 *
 * **Runs after payment, from the Stripe webhook, not at booking creation.** Stamping
 * `legacy_id` is what makes a booking look Xano-synced, and the confirmation trigger
 * deliberately skips those so nobody is texted twice. Mirroring at creation therefore
 * silenced the guest's own confirmation, since by payment time the id was already set.
 * Mirroring after payment gets both: the text goes out, then Xano receives its copy.
 *
 * Two things keep this from double-texting the guest:
 *
 *  1. **No phone.** Xano's booking SMS trigger reads the phone off the booking row.
 *     `booking/v12` maps the literal string "null" to a null phone, so the trigger has
 *     no destination and sends nothing. Confirmed with the owner that the trigger stops
 *     there and does not fall back to the contact record.
 *  2. **`trigger: false`.** A second brake, free to set, in case a campaign trigger keys
 *     off that flag rather than the phone.
 *
 * And one thing keeps the booking from coming back at us as a duplicate: Xano's
 * "New Supabase platfomr" trigger mirrors every `bookings` row into Supabase via
 * `xano-booking-sync`, which upserts on `legacy_id` derived as `ota-<booking_reference>`.
 * We choose the reference ourselves and stamp the matching `legacy_id` on our own row,
 * so the round trip updates the booking we already created instead of inserting a second.
 *
 * Never throws. A mirror failure is logged and the guest's booking stands: the Supabase
 * row is the source of truth for the test.
 *
 * OFF unless the GP_XANO_MIRROR secret is "true" AND XANO_API_TOKEN is set. This is the
 * only path in the codebase that writes to Xano; delete this file, its secrets, and the
 * call in index.ts when the test ends. See docs/gp-xano-mirror.md.
 */

const XANO_BOOKINGS_API = "https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn";
const XANO_GP_CHANNEL = "groupon-surcharge";
const TIMEOUT_MS = 8_000;

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { nyDateString } from "./ny-time.ts";

/** Booking reference shared by both systems. Also the Xano internal_id. */
export function gpMirrorRef(): string {
  return `GP-${crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

/** The `legacy_id` xano-booking-sync will compute for that reference. */
export const gpMirrorLegacyId = (ref: string): string => `ota-${ref}`;

export function gpMirrorEnabled(): boolean {
  return (
    Deno.env.get("GP_XANO_MIRROR") === "true" &&
    Boolean(Deno.env.get("XANO_API_TOKEN")?.trim())
  );
}

export interface GpMirrorInput {
  ref: string;
  /**
   * The booking's real status. Sending a hardcoded "confirmed" is what let an unpaid
   * /gp booking come back through Xano's sync and overwrite our `pending` row as
   * confirmed, erasing the fact that nobody had paid.
   */
  status: "pending" | "confirmed";
  publicToken: string;
  legacyCompanyId: string | null;
  legacyProductId: string | null;
  productName: string;
  supplierName: string;
  customerName: string;
  startsAtIso: string;
  passengers: number;
  voucherImageUrls: string[];
  note: string;
}

/** "Ada Lovelace" -> { first: "Ada", last: "Lovelace" } */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export async function mirrorGpBookingToXano(
  input: GpMirrorInput,
): Promise<{ ok: boolean; error?: string }> {
  if (!gpMirrorEnabled()) return { ok: false, error: "disabled" };
  if (!input.legacyCompanyId || !input.legacyProductId) {
    return { ok: false, error: "product is not linked to Xano" };
  }

  const { first, last } = splitName(input.customerName);
  const startedAt = new Date(input.startsAtIso);

  const payload = {
    internal_id: input.ref,
    booking_reference: input.ref,
    booking_channel: XANO_GP_CHANNEL,
    company: input.legacyCompanyId,
    product: input.legacyProductId,
    product_var: input.productName,
    supplier: input.supplierName,
    customer_name: `${last}, ${first}`.trim(),
    Fname: first,
    Lname: last,
    // The whole point: no phone, so Xano's SMS trigger has nowhere to send.
    phone: "null",
    email: "",
    date: nyDateString(input.startsAtIso),
    date_timestamp: startedAt.getTime(),
    adult: input.passengers,
    child: 0,
    infant: 0,
    paxs: input.passengers,
    status: input.status,
    payment_status: input.status === "confirmed" ? "paid" : "unpaid",
    checked: false,
    live: true,
    trigger: false,
    kiosk: "",
    note: input.note,
    unique_id: "",
    contact_status: "new",
    autoreschedule: false,
    bookingConfirmation_id: input.publicToken,
    // Every voucher in ONE comma-joined element, which looks wrong and is not.
    // Xano's booking/v12 reads this field as `image_url|get:0|split:","`: it takes
    // element 0 and splits it on commas, so the list it stores is built from that
    // single string. Sending one URL per element therefore loses every voucher
    // after the first. Do not "fix" this without changing booking/v12 first.
    image_url: input.voucherImageUrls.length ? [input.voucherImageUrls.join(",")] : [],
    pickupLocation_id: null,
    dropoffLocation_id: null,
    check_in_time: null,
  };

  try {
    const res = await fetch(`${XANO_BOOKINGS_API}/booking/v12`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${Deno.env.get("XANO_API_TOKEN")}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Xano ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read a Groupon booking, claim it, and mirror it into Xano.
 *
 * Both entry points call this: the Stripe webhook once a paid booking flips to confirmed,
 * and `gp-book` directly for a $0 convenience fee, which has no payment to wait for and so
 * never reaches the webhook at all.
 *
 * Must run AFTER the booking is already `confirmed`, never before. Stamping `legacy_id` is
 * what marks a booking as Xano-synced, and the confirmation trigger's WHEN clause skips
 * those, so mirroring first silences the guest's own text.
 *
 * No-ops unless the booking is a Groupon booking that has not been mirrored yet. Never
 * throws: a mirror failure is logged and the Supabase booking stands, since that is the
 * source of truth.
 *
 * `sb` must be a service-role client: it reads and stamps a booking regardless of RLS.
 */
export async function mirrorGrouponBooking(
  sb: SupabaseClient,
  bookingId: string,
): Promise<void> {
  if (!gpMirrorEnabled()) return;

  interface MirrorRow {
    id: string;
    legacy_id: string | null;
    source_channel: string | null;
    starts_at: string;
    pax_adult: number | null;
    notes: string | null;
    public_token: string;
    groupon_voucher_urls: string[] | null;
    customer: { full_name: string | null } | null;
    business_tour: {
      name: string;
      legacy_product_id: string | null;
      business: { name: string; legacy_company_id: string | null } | null;
    } | null;
  }

  const { data: booking } = await sb
    .from("bookings")
    .select(
      "id, legacy_id, source_channel, starts_at, pax_adult, notes, public_token, groupon_voucher_urls, " +
        "customer:customers(full_name), " +
        "business_tour:business_tours(name, legacy_product_id, business:businesses(name, legacy_company_id))",
    )
    .eq("id", bookingId)
    .maybeSingle<MirrorRow>();

  if (!booking || booking.source_channel !== "groupon") return;
  // Already mirrored (the webhook can deliver checkout.session.completed AND
  // payment_intent.succeeded for the same sale).
  if (booking.legacy_id) return;

  const ref = gpMirrorRef();

  // Claim the row before calling Xano, so two concurrent deliveries cannot both mirror.
  const { data: claimed } = await sb
    .from("bookings")
    .update({ legacy_id: gpMirrorLegacyId(ref) })
    .eq("id", bookingId)
    .is("legacy_id", null)
    .select("id");
  if (!claimed || claimed.length === 0) return;

  const bt = booking.business_tour;

  const mirror = await mirrorGpBookingToXano({
    ref,
    status: "confirmed",
    publicToken: booking.public_token,
    legacyCompanyId: bt?.business?.legacy_company_id ?? null,
    legacyProductId: bt?.legacy_product_id ?? null,
    productName: bt?.name ?? "",
    supplierName: bt?.business?.name ?? "",
    customerName: booking.customer?.full_name ?? "",
    startsAtIso: booking.starts_at,
    passengers: booking.pax_adult ?? 1,
    voucherImageUrls: booking.groupon_voucher_urls ?? [],
    note: booking.notes ?? "",
  });
  if (!mirror.ok) {
    console.error(`[gp] Xano mirror failed for booking ${bookingId} (${ref}): ${mirror.error}`);
  }
}
