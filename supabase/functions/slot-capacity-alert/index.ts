// Capacity alert: text and email staff when a departure is close to full.
//
// The bookings triggers (on_booking_capacity_alert, insert + the edits that can
// add seats) call this once per booking, and only while
// messaging_settings.slot_alerts_enabled is true. Port of Xano's "city tour
// full notification" trigger, generalised: an alert holds one or more products
// (Xano's city tour alert covered two that share a bus), carries a fixed seat
// threshold and its own recipients, and is set on /admin/messaging.
//
// Sending twice is the failure that matters here, so the dedupe row is CLAIMED
// before anything goes out: the unique (alert, departure) key means a retry,
// a concurrent booking, or a redelivered call simply finds the seat taken and
// stops. A crash between the claim and the send loses one alert instead.
//
// Auth: x-cron-secret must equal the CRON_SECRET function secret (the same value
// the dispatcher and run-booking-automations use). SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are auto-injected.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendSms } from "../_shared/sms.ts";
import { withSentry } from "../_shared/sentry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const DEFAULT_EMAIL_FROM = "PrimeWillCall Alerts <alerts@alert.primewillcall.com>";

interface BookingRow {
  starts_at: string;
  status: string;
  awaiting_payment: boolean;
  business_tour: { tour: { id: string } | null } | null;
}

interface AlertRow {
  id: string;
  name: string;
  threshold_pax: number;
  phones: string[] | null;
  emails: string[] | null;
  is_active: boolean;
}

/** "September 12 at 2:00PM", in business time. */
function slotLabel(startsAt: string): string {
  const at = new Date(startsAt);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(at).replace(" ", "");
  return `${day} at ${time}`;
}

/** Send one email through Resend. Returns whether it went. */
async function sendEmail(from: string, to: string, subject: string, text: string) {
  if (!RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

Deno.serve(withSentry("slot-capacity-alert", async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let bookingId = "";
  try {
    bookingId = String((await req.json())?.booking_id ?? "").trim();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!bookingId) return Response.json({ error: "missing booking_id" }, { status: 400 });

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Kill switch, checked again here: the trigger reads it too, but this call is
  // the one that spends money.
  const { data: settings } = await db
    .from("messaging_settings")
    .select("slot_alerts_enabled, alert_email_from")
    .eq("id", true)
    .maybeSingle();
  if (!settings?.slot_alerts_enabled) {
    return Response.json({ skipped: "capacity alerts disabled" });
  }

  const { data: booking } = await db
    .from("bookings")
    .select("starts_at, status, awaiting_payment, business_tour:business_tours(tour:tours(id))")
    .eq("id", bookingId)
    .maybeSingle<BookingRow>();

  const tour = booking?.business_tour?.tour ?? null;
  if (!booking || !tour) return Response.json({ skipped: "booking not found" });
  if (booking.status === "cancelled" || booking.awaiting_payment) {
    return Response.json({ skipped: "booking does not hold seats" });
  }
  if (new Date(booking.starts_at).getTime() <= Date.now()) {
    return Response.json({ skipped: "departure already gone" });
  }

  // Which alert watches this product? At most one, by unique index.
  const { data: link } = await db
    .from("capacity_alert_tours")
    .select("alert:capacity_alerts(id, name, threshold_pax, phones, emails, is_active)")
    .eq("tour_id", tour.id)
    .maybeSingle<{ alert: AlertRow | null }>();

  const config = link?.alert ?? null;
  if (!config || !config.is_active) {
    return Response.json({ skipped: "no alert watches this product" });
  }

  const { data: seats, error: seatsError } = await db.rpc("capacity_alert_seats", {
    p_alert_id: config.id,
    p_starts_at: booking.starts_at,
  });
  if (seatsError) {
    return Response.json({ error: seatsError.message }, { status: 500 });
  }
  const booked = Number(seats ?? 0);
  if (booked < config.threshold_pax) {
    return Response.json({ skipped: "below threshold", seats: booked });
  }

  // Claim the departure. A duplicate key means someone else already alerted.
  const { data: claim, error: claimError } = await db
    .from("capacity_alert_log")
    .insert({
      alert_id: config.id,
      starts_at: booking.starts_at,
      seats: booked,
      threshold_pax: config.threshold_pax,
    })
    .select("id")
    .maybeSingle();
  if (claimError || !claim) {
    return Response.json({ skipped: "already alerted", seats: booked });
  }

  const when = slotLabel(booking.starts_at);
  const body = `${config.name} is filling up. ${when}: ${booked} guests booked.`;

  const phones: string[] = config.phones ?? [];
  const emails: string[] = config.emails ?? [];

  const smsResults = await Promise.all(
    phones.map((phone) => sendSms({ to: phone, body, tag: "capacity_alert" })),
  );
  const emailResults = await Promise.all(
    emails.map((email) =>
      sendEmail(settings.alert_email_from ?? DEFAULT_EMAIL_FROM, email, `${config.name} is filling up`, body)
    ),
  );

  const smsSent = smsResults.filter((r) => r.sent).length;
  const emailsSent = emailResults.filter(Boolean).length;

  await db
    .from("capacity_alert_log")
    .update({ sms_sent: smsSent, emails_sent: emailsSent })
    .eq("id", claim.id);

  return Response.json({ alerted: true, seats: booked, sms_sent: smsSent, emails_sent: emailsSent });
}));
