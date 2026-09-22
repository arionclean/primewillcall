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
 * Three ids open the page, all exact matches on indexed columns:
 *   - `public_token`, ours, the one in the texts this app sends;
 *   - `xano_confirmation_token`, the code in the bked.io/booking/<code> links Xano
 *     still texts for the bookings it creates (filled by the xano-ticket-tokens
 *     sweep), so those links open here once that domain points at this app;
 *   - `xano_internal_id`, Xano's PW- code, for anything that carries that instead.
 * One query, and it must match exactly one booking: Xano reuses a PW- code across
 * people now and then, and a code matching two rows resolves to nothing rather
 * than risk showing another guest's row.
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

  const safe = token.replace(/[^A-Za-z0-9_-]/g, "");
  if (safe !== token) {
    return <BookingNotFound />;
  }

  const { data: matches } = await admin
    .from("bookings")
    .select(BOOKING_SELECT)
    .or(`public_token.eq.${safe},xano_confirmation_token.eq.${safe},xano_internal_id.eq.${safe}`)
    .limit(2);

  const data = matches?.length === 1 ? matches[0] : null;

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
