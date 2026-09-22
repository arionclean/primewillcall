import type { Metadata } from "next";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import { BookingNotFound, BookingView, type PublicBooking } from "./booking-view";

export const metadata: Metadata = {
  title: "Your booking",
  description: "Booking details, meeting point, and support.",
  robots: { index: false, follow: false },
};

const BUSINESS_TZ = "America/New_York";

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function formatDeparture(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function paxDetail(adult: number, child: number, infant: number): string {
  const parts: string[] = [];
  if (adult > 0) parts.push(`${adult} ${adult === 1 ? "adult" : "adults"}`);
  if (child > 0) parts.push(`${child} ${child === 1 ? "child" : "children"}`);
  if (infant > 0) parts.push(`${infant} ${infant === 1 ? "infant" : "infants"}`);
  return parts.join(", ");
}

function formatPhoneDisplay(digits: string): string {
  const d = digits.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length !== 10) return digits;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function phoneTel(digits: string): string {
  const d = digits.replace(/\D/g, "");
  return d.length === 10 ? `+1${d}` : `+${d}`;
}

const BOOKING_SELECT = `starts_at, status, pax_adult, pax_child, pax_infant,
   customer:customers(full_name),
   business_tour:business_tours(
     name,
     tour:tours(meeting_point_address, meeting_point_lat, meeting_point_lng, instructions)
   ),
   business:businesses(name, phone, contact_email, logo_url)`;

/**
 * Public, unauthenticated booking-details page: the link a guest receives after
 * booking. Same public pattern as /gp: it sits outside the (app) route group so
 * the auth gate never runs, it is absent from the middleware matcher, and data
 * is read server-side with the service role, only ever by an exact id.
 *
 * Two ids open the page. Ours is `public_token`. The second is Xano's own
 * booking code (`xano_internal_id`, the PW- code), so the legacy bked.io ticket
 * link can redirect here carrying the code Bubble already holds, with no token
 * mapping to keep in sync. Xano reuses a PW- code across people now and then
 * (23 of 6,143 at the time of writing), so a code matching more than one
 * booking resolves to nothing rather than risk showing another guest's row.
 */
export default async function PublicBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const admin = getSupabaseAdminClient();
  if (!admin || !token || token.length > 64) {
    return <BookingNotFound />;
  }

  const byToken = await admin
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("public_token", token)
    .maybeSingle();

  let data = byToken.data;

  if (!data) {
    // Legacy bked.io link: Xano's PW- code. Two rows means the code was reused,
    // and we would rather show nothing than the wrong guest.
    const byXanoId = await admin
      .from("bookings")
      .select(BOOKING_SELECT)
      .eq("xano_internal_id", token)
      .limit(2);
    if (byXanoId.data?.length === 1) {
      data = byXanoId.data[0];
    }
  }

  if (!data) {
    return <BookingNotFound />;
  }

  const tour = data.business_tour?.tour ?? null;
  const lat = tour?.meeting_point_lat;
  const lng = tour?.meeting_point_lng;
  const address = tour?.meeting_point_address ?? null;
  const mapsUrl =
    lat != null && lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
      : address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
        : null;

  const totalPax = data.pax_adult + data.pax_child + data.pax_infant;
  const phone = data.business?.phone ?? null;

  const booking: PublicBooking = {
    productName: data.business_tour?.name ?? data.business?.name ?? "Your tour",
    businessName: data.business?.name ?? "",
    logoUrl: data.business?.logo_url ?? null,
    whenLabel: formatWhen(data.starts_at),
    departureLabel: formatDeparture(data.starts_at),
    guestName: data.customer?.full_name ?? "Guest",
    totalPax,
    paxDetail: paxDetail(data.pax_adult, data.pax_child, data.pax_infant),
    status: data.status,
    meetingAddress: address,
    mapsUrl,
    instructions: tour?.instructions ?? null,
    supportEmail: data.business?.contact_email ?? null,
    supportPhoneDisplay: phone ? formatPhoneDisplay(phone) : null,
    supportPhoneTel: phone ? phoneTel(phone) : null,
  };

  return <BookingView booking={booking} />;
}
