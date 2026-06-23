import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Public Groupon booking creator for the /gp page. Runs server-side with the
 * service role. Re-validates everything against the database (never trusts the
 * client's fee), creates the customer, and writes a `pending` ("waiting for
 * payment") booking on the groupon channel. Payment (Stripe) is the final
 * migration phase and is stubbed: the booking is created, the charge is not.
 */

const BUSINESS_TZ = "America/New_York";

/** Wall-clock New York date + time -> UTC ISO string (DST-correct). */
function nyLocalToUtcIso(yyyyMmDd: string, hhmm: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const candidate = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const tzLabel =
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(candidate)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const off = tzLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = off?.[1] === "-" ? -1 : 1;
  const offMin = sign * (Number(off?.[2] ?? 0) * 60 + Number(off?.[3] ?? 0));
  return new Date(candidate.getTime() - offMin * 60_000).toISOString();
}

type Body = {
  businessTourId?: string;
  customerName?: string;
  phone?: string;
  date?: string;
  slotStart?: string;
  passengers?: number;
  voucherCodes?: string[];
  voucherCode?: string | null; // legacy single-code shape, still accepted
  imageUrl?: string | null;
};

export async function POST(req: Request) {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "not_configured", message: "Booking is not configured." },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const businessTourId = String(body.businessTourId ?? "").trim();
  const customerName = String(body.customerName ?? "").trim();
  const phone = String(body.phone ?? "").replace(/\D/g, "") || null;
  const date = String(body.date ?? "").trim();
  const slotStart = String(body.slotStart ?? "").trim().slice(0, 5);
  const passengers = Math.max(1, Math.floor(Number(body.passengers) || 0));
  const voucherCodes = (
    Array.isArray(body.voucherCodes)
      ? body.voucherCodes
      : body.voucherCode
        ? [body.voucherCode]
        : []
  )
    .map((c) => String(c ?? "").trim())
    .filter(Boolean);
  const imageUrl = String(body.imageUrl ?? "").trim() || null;

  if (!businessTourId || !customerName) {
    return NextResponse.json(
      { ok: false, error: "missing_fields", message: "Name and product are required." },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(slotStart)) {
    return NextResponse.json(
      { ok: false, error: "bad_datetime", message: "Pick a valid date and time." },
      { status: 400 },
    );
  }

  // Authoritative product + fee (never trust the client's fee).
  const { data: bt } = await admin
    .from("business_tours")
    .select("id, business_id, tour_id, is_active, groupon_fee_cents")
    .eq("id", businessTourId)
    .maybeSingle();
  if (!bt || !bt.is_active || bt.groupon_fee_cents === null) {
    return NextResponse.json(
      { ok: false, error: "not_available", message: "This product is not accepting Groupon." },
      { status: 400 },
    );
  }
  const feeCents = bt.groupon_fee_cents;

  // The slot must belong to this tour; take its duration authoritatively.
  const { data: slots } = await admin
    .from("tour_timeslots")
    .select("start_time, duration_minutes")
    .eq("tour_id", bt.tour_id)
    .eq("is_active", true);
  const slot = (slots ?? []).find((s) => s.start_time.slice(0, 5) === slotStart);
  if (!slot) {
    return NextResponse.json(
      { ok: false, error: "bad_slot", message: "That time is no longer available." },
      { status: 400 },
    );
  }

  const startsAtIso = nyLocalToUtcIso(date, slotStart);
  const endsAtIso = new Date(
    new Date(startsAtIso).getTime() + slot.duration_minutes * 60_000,
  ).toISOString();

  const totalCents = feeCents * passengers;
  const breakdown = [
    {
      label: "Groupon convenience fee",
      qty: passengers,
      unit_price_cents: feeCents,
      line_total_cents: totalCents,
    },
  ];

  // Customer.
  const { data: customer, error: custErr } = await admin
    .from("customers")
    .insert({
      business_id: bt.business_id,
      full_name: customerName,
      phone,
      legacy_source: "groupon",
    })
    .select("id")
    .single();
  if (custErr || !customer) {
    return NextResponse.json(
      { ok: false, error: "server_error", message: custErr?.message ?? "Could not save customer." },
      { status: 500 },
    );
  }

  // Pending booking on the groupon channel.
  const noteParts = ["Groupon redemption"];
  if (voucherCodes.length) {
    noteParts.push(`code${voucherCodes.length > 1 ? "s" : ""} ${voucherCodes.join(", ")}`);
  }
  if (imageUrl) noteParts.push(`voucher ${imageUrl}`);

  const { data: booking, error: bookErr } = await admin
    .from("bookings")
    .insert({
      business_id: bt.business_id,
      business_tour_id: bt.id,
      customer_id: customer.id,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      status: "pending",
      total_cents: totalCents,
      currency: "usd",
      pax_adult: passengers,
      pax_child: 0,
      pax_infant: 0,
      tour_pax_breakdown: breakdown,
      source_channel: "groupon",
      legacy_reference: voucherCodes.join(", ") || null,
      notes: noteParts.join(" · "),
    })
    .select("id")
    .single();
  if (bookErr || !booking) {
    return NextResponse.json(
      { ok: false, error: "server_error", message: bookErr?.message ?? "Could not save booking." },
      { status: 500 },
    );
  }

  // Stripe is the final migration phase. The pending booking is created; the
  // charge is not wired yet, so we return a stub instead of a checkout URL.
  return NextResponse.json({
    ok: true,
    bookingId: booking.id,
    feeCents,
    passengers,
    totalCents,
    payment: { status: "stubbed", checkoutUrl: null },
  });
}
