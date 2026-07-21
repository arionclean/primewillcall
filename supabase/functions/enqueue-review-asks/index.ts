// Review funnel sweep (ENQUEUE ONLY - never calls Twilio).
//
// Two passes, driven by pg_cron:
//   1. ASK    - checked-in bookings whose tour has ended get the 1-5 ask.
//   2. RE-ASK - asks that were DELIVERED 24h ago and never answered get one
//               nudge. This is Xano's rateAsk2 and it earns a large share of
//               the replies, so it is not optional.
//
// The reply branch (5 -> Google link, 1-4 -> private follow-up) is not here:
// it happens on the inbound webhook, in src/lib/reviews/funnel.ts.
//
// Rules ported from Xano fn 94 "add to flowList DB" and task 9:
//   * only guests who were actually CHECKED IN, so no-shows are never asked
//   * unchecking cancels everything (that is a DB trigger, cancel_review_funnel)
//
// Xano also skips a check-in that lands more than 6h after the tour. That guard
// is deliberately NOT ported: review_ask_lookback_hours already bounds how far
// back the sweep reaches, which covers the same runaway risk.
//
// Five brakes against a runaway, in order:
//   1. review_automation_enabled - its own switch, default false.
//      automations_enabled is ALREADY true for booking confirmations, so this
//      funnel deliberately does not ride on it.
//   2. legacy_id IS NULL - never touches the ~90k Xano-synced bookings, which
//      Xano's own rateAsk campaign still handles. This is what stops double SMS.
//   3. review_ask_lookback_hours - bounded window, so switching this on can
//      never back-text every booking in history.
//   4. checked_in_at IS NOT NULL - only guests who actually turned up.
//   5. The business must have google_review_url set.
//
// Everything is queued into scheduled_messages, so the dispatcher's global
// hourly cap still governs actual spend.
//
// Auth: x-cron-secret must equal the CRON_SECRET function secret.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

// Hard ceilings per run, independent of the settings windows.
const ASK_BATCH = 200;
const REASK_BATCH = 200;

const TAG_ASK = "review_ask";
const TAG_REASK = "review_reask";


function firstName(fullName: string | null): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "there";
}

function askBody(name: string): string {
  return (
    `Hi ${name}! We'd love to know how your experience was. Could you rate ` +
    "it 1 to 5, with 5 being the best? Your feedback helps us improve every day!"
  );
}

function reaskBody(name: string): string {
  return (
    `Hey ${name}, just a quick reminder in case you missed it. Could you ` +
    "rate your experience from 1 to 5? I really appreciate your time. Thanks again!"
  );
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: settings } = await db
    .from("messaging_settings")
    .select(
      "automations_enabled, review_automation_enabled, review_ask_delay_hours, " +
        "review_ask_lookback_hours, review_reminder_hours",
    )
    .eq("id", true)
    .maybeSingle();

  // Brake 1. Both switches must be on.
  if (!settings?.automations_enabled || !settings?.review_automation_enabled) {
    return Response.json({ skipped: "review automation disabled" });
  }

  const nowMs = Date.now();
  const HOUR = 3_600_000;
  const askDelayMs = (settings.review_ask_delay_hours ?? 3) * HOUR;

  // ------------------------------------------------------------------
  // Pass 1: the ask.
  // ------------------------------------------------------------------
  let asked = 0;

  // Brake 3. Only tours that ended inside the window.
  const endedAfter = new Date(nowMs - (settings.review_ask_lookback_hours ?? 48) * HOUR).toISOString();
  const endedBefore = new Date(nowMs).toISOString();

  const { data: candidates, error: candErr } = await db
    .from("bookings")
    .select(
      "id, business_id, customer_id, ends_at, checked_in_at, " +
        "customer:customers(full_name, phone), business:businesses(google_review_url)",
    )
    // Brake 2. Supabase-native bookings only. Xano still texts its own.
    .is("legacy_id", null)
    .gte("ends_at", endedAfter)
    .lte("ends_at", endedBefore)
    // Brake 4. Only guests who actually turned up.
    .not("checked_in_at", "is", null)
    .neq("status", "cancelled")
    .order("ends_at", { ascending: false })
    .limit(ASK_BATCH);

  if (candErr) {
    return Response.json({ error: `candidates: ${candErr.message}` }, { status: 500 });
  }

  const bookings = candidates ?? [];

  if (bookings.length > 0) {
    // Idempotency: skip anything already in the funnel (asked OR cancelled).
    const ids = bookings.map((b) => b.id);
    const { data: existing } = await db.from("reviews").select("booking_id").in("booking_id", ids);
    const alreadyInFunnel = new Set((existing ?? []).map((r) => r.booking_id));

    const phones = bookings
      .map((b) => (b.customer as { phone: string | null } | null)?.phone ?? "")
      .filter(Boolean);
    const { data: optOuts } = await db
      .from("sms_opt_outs")
      .select("phone_number")
      .in("phone_number", phones)
      .eq("opted_out", true);
    const blocked = new Set((optOuts ?? []).map((o) => o.phone_number));

    const reviewRows: Record<string, unknown>[] = [];
    const pending: { toPhone: string; name: string; booking: (typeof bookings)[number] }[] = [];

    for (const booking of bookings) {
      if (alreadyInFunnel.has(booking.id)) continue;

      const customer = booking.customer as { full_name: string | null; phone: string | null } | null;
      const business = booking.business as { google_review_url: string | null } | null;

      const toPhone = (customer?.phone ?? "").trim();
      if (!toPhone || blocked.has(toPhone)) continue;

      // Brake 5. Nowhere to send happy customers means do not ask at all.
      if (!(business?.google_review_url ?? "").trim()) continue;

      reviewRows.push({
        business_id: booking.business_id,
        booking_id: booking.id,
        customer_id: booking.customer_id,
        asked_at: new Date(nowMs).toISOString(),
      });
      pending.push({ toPhone, name: firstName(customer?.full_name ?? null), booking });
    }

    if (reviewRows.length > 0) {
      // Reviews first: the unique index on booking_id is what makes a
      // concurrent second run a no-op rather than a double text.
      const { error: reviewErr } = await db.from("reviews").insert(reviewRows);
      if (reviewErr) {
        return Response.json({ error: `reviews insert: ${reviewErr.message}` }, { status: 500 });
      }

      const messageRows = pending.map((p) => ({
        to_phone: p.toPhone,
        channel: "sms",
        body: askBody(p.name),
        business_id: p.booking.business_id,
        booking_id: p.booking.id,
        customer_id: p.booking.customer_id,
        tag: TAG_ASK,
        // Measured from when the TOUR ended, not from when this sweep ran, so
        // the wait is exact whatever the cron cadence is.
        send_at: new Date(new Date(p.booking.ends_at).getTime() + askDelayMs).toISOString(),
        status: "pending",
      }));

      const { error: msgErr } = await db.from("scheduled_messages").insert(messageRows);
      if (msgErr) {
        return Response.json({ error: `enqueue ask: ${msgErr.message}` }, { status: 500 });
      }
      asked = messageRows.length;
    }
  }

  // ------------------------------------------------------------------
  // Pass 2: the 24h re-ask, for people who never answered.
  //
  // Keyed off the ask actually being DELIVERED (status sent), not merely
  // queued, so a message stuck behind the hourly cap does not start the
  // 24h clock before the customer has seen anything.
  // ------------------------------------------------------------------
  let reasked = 0;
  const deliveredBefore = new Date(nowMs - (settings.review_reminder_hours ?? 24) * HOUR).toISOString();

  const { data: sentAsks } = await db
    .from("scheduled_messages")
    .select("booking_id, to_phone, sent_at")
    .eq("tag", TAG_ASK)
    .eq("status", "sent")
    .not("booking_id", "is", null)
    .lte("sent_at", deliveredBefore)
    .order("sent_at", { ascending: false })
    .limit(REASK_BATCH);

  const askedBookings = sentAsks ?? [];

  if (askedBookings.length > 0) {
    const bookingIds = askedBookings.map((a) => a.booking_id as string);

    // Still waiting on a reply: no rating, not cancelled, not already nudged.
    const { data: openRows } = await db
      .from("reviews")
      .select("id, business_id, booking_id, customer_id")
      .in("booking_id", bookingIds)
      .is("rating", null)
      .is("cancelled_at", null)
      .is("reask_sent_at", null);

    const open = openRows ?? [];
    if (open.length > 0) {
      const phoneByBooking = new Map(
        askedBookings.map((a) => [a.booking_id as string, a.to_phone as string]),
      );
      const { data: optOuts } = await db
        .from("sms_opt_outs")
        .select("phone_number")
        .in("phone_number", [...phoneByBooking.values()])
        .eq("opted_out", true);
      const blocked = new Set((optOuts ?? []).map((o) => o.phone_number));

      // Names for the greeting.
      const customerIds = open.map((r) => r.customer_id).filter(Boolean) as string[];
      const { data: customers } = await db
        .from("customers")
        .select("id, full_name")
        .in("id", customerIds);
      const nameById = new Map((customers ?? []).map((c) => [c.id, c.full_name]));

      const rows: Record<string, unknown>[] = [];
      const reaskedIds: string[] = [];

      for (const review of open) {
        const phone = phoneByBooking.get(review.booking_id as string);
        if (!phone || blocked.has(phone)) continue;
        rows.push({
          to_phone: phone,
          channel: "sms",
          body: reaskBody(firstName(nameById.get(review.customer_id as string) ?? null)),
          business_id: review.business_id,
          booking_id: review.booking_id,
          customer_id: review.customer_id,
          tag: TAG_REASK,
          send_at: new Date(nowMs).toISOString(),
          status: "pending",
        });
        reaskedIds.push(review.id);
      }

      if (rows.length > 0) {
        const { error } = await db.from("scheduled_messages").insert(rows);
        if (error) {
          return Response.json({ error: `enqueue re-ask: ${error.message}` }, { status: 500 });
        }
        // Stamp regardless of send outcome so nobody is nudged twice.
        await db
          .from("reviews")
          .update({ reask_sent_at: new Date(nowMs).toISOString() })
          .in("id", reaskedIds);
        reasked = rows.length;
      }
    }
  }

  return Response.json({ asked, reasked });
});
