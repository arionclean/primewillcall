// The safety net under the inbound email intake. pg_cron calls this every 5 minutes.
//
// Two jobs, and the second one is the reason this exists at all:
//
//   1. Retry. Any inbound_emails row that is still unfinished gets another pass.
//      Resend keeps the email, and both the parse and the booking upsert are safe to
//      repeat, so a retry is free. A row that runs out of attempts is marked failed
//      and alerted once.
//
//   2. Notice the silence. Every row-level check in the world cannot tell you about
//      the email that never arrived. A deleted forwarding rule, an MX record edited
//      during some unrelated DNS change, a suspended Resend domain: the intake goes
//      quiet and every screen looks normal, while real guests hold reservations this
//      platform has never heard of. So: if email HAS been flowing and then stops for
//      longer than inbound_email_settings.silence_minutes during the hours it should
//      be flowing, alert. This is what Make's execution history could not do either,
//      because an execution that never happens leaves nothing to look at.
//
// The alarm is deliberately one-shot per silence_minutes window (last_silence_alert_at),
// and asleep overnight (quiet_from_hour / quiet_to_hour, New York), because an alert
// that cries every five minutes at 4am gets muted, and a muted alarm is no alarm.
//
// Auth: x-cron-secret must equal CRON_SECRET, like the other cron functions.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { withSentry } from "../_shared/sentry.ts";
import { BUSINESS_TZ } from "../_shared/ny-time.ts";
import { processInbound } from "../_shared/inbound-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const SMS_FROM = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";

/** Rows per run. A pass can call the AI product match, so this is a budget, not a cap. */
const BATCH = 20;
/** Leave the first pass (in email-inbound) alone for this long before retrying it. */
const RETRY_AFTER_MINUTES = 5;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Settings = {
  alerts_enabled: boolean;
  silence_minutes: number;
  quiet_from_hour: number;
  quiet_to_hour: number;
  max_attempts: number;
  last_silence_alert_at: string | null;
};

type PendingRow = {
  id: string;
  provider_email_id: string;
  subject: string | null;
  raw_text: string | null;
  to_addresses: string[] | null;
  legacy_company_id: string | null;
  attempts: number;
};

/** The hour of the day in New York right now (0-23). */
function nyHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
}

/** True while the silence alarm is asleep. Handles a window that wraps midnight. */
function inQuietHours(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

async function sendResendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "PrimeWillCall Alerts <alerts@alert.primewillcall.com>",
        to: [to],
        subject,
        text,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendSmsAlert(to: string, body: string): Promise<boolean> {
  if (!SMS_FROM || !ACCOUNT_SID || !AUTH_TOKEN) return false;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: SMS_FROM, Body: body }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Tell the owner, on both channels. Email carries the detail, the text carries the
 * urgency; a missed booking is worth waking someone for.
 */
async function alertOwner(subject: string, detail: string, sms: string): Promise<boolean> {
  const { data: settings } = await sb
    .from("messaging_settings")
    .select("alert_email, alert_phone")
    .eq("id", true)
    .maybeSingle();
  let notified = false;
  if (settings?.alert_email) {
    notified = await sendResendEmail(settings.alert_email, subject, detail) || notified;
  }
  if (settings?.alert_phone) {
    notified = await sendSmsAlert(settings.alert_phone, sms) || notified;
  }
  return notified;
}

/** One retry pass over a row, mirroring email-inbound's. Returns the new status. */
async function retry(row: PendingRow, maxAttempts: number): Promise<string> {
  const attempts = row.attempts + 1;
  try {
    const out = await processInbound(row);

    let bookingId: string | null = null;
    if (out.legacy_id) {
      const { data } = await sb
        .from("bookings")
        .select("id")
        .eq("legacy_id", out.legacy_id)
        .maybeSingle();
      bookingId = (data?.id as string | undefined) ?? null;
    }

    await sb
      .from("inbound_emails")
      .update({
        status: out.status,
        raw_text: out.raw_text,
        legacy_company_id: out.legacy_company_id,
        booking_id: bookingId,
        business_tour_id: out.business_tour_id,
        match_queue_id: out.match_queue_id,
        attempts,
        last_attempt_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", row.id);
    return out.status;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const done = attempts >= maxAttempts;
    await sb
      .from("inbound_emails")
      .update({
        status: done ? "failed" : "received",
        attempts,
        last_attempt_at: new Date().toISOString(),
        error: message,
        ...(done ? { alert_sent_at: new Date().toISOString() } : {}),
      })
      .eq("id", row.id);

    if (done) {
      await alertOwner(
        "PrimeWillCall: an OTA booking email could not be processed",
        `An inbound reservation email failed ${attempts} times and has been given up on.\n\n` +
          `Subject: ${row.subject ?? "(none)"}\n` +
          `Resend id: ${row.provider_email_id}\n` +
          `Last error: ${message}\n\n` +
          `This guest may hold a reservation that is NOT on the manifest. ` +
          `Open /admin/inbound to read the email and book it by hand.`,
        `PrimeWillCall ALERT: an OTA booking email failed to process (${message.slice(0, 60)}). ` +
          `Check /admin/inbound, the guest may not be on the manifest.`,
      );
    }
    return done ? "failed" : "received";
  }
}

/** The pipeline has gone quiet. Returns true when an alert was raised. */
async function checkSilence(s: Settings): Promise<{ alerted: boolean; reason?: string }> {
  if (!s.alerts_enabled) return { alerted: false, reason: "alerts off" };
  if (inQuietHours(nyHour(), s.quiet_from_hour, s.quiet_to_hour)) {
    return { alerted: false, reason: "quiet hours" };
  }

  // Only ever alert about a pipeline that HAS worked. Before the Resend webhook is
  // pointed here there is no silence to report, only an absence, and an alarm that
  // fires before go-live is an alarm nobody trusts afterwards.
  const { data: newest } = await sb
    .from("inbound_emails")
    .select("received_at")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!newest?.received_at) return { alerted: false, reason: "no email ever received" };

  const quietMs = Date.now() - new Date(newest.received_at).getTime();
  const thresholdMs = s.silence_minutes * 60_000;
  if (quietMs < thresholdMs) return { alerted: false, reason: "flowing" };

  // One alert per window, not one every five minutes.
  if (
    s.last_silence_alert_at &&
    Date.now() - new Date(s.last_silence_alert_at).getTime() < thresholdMs
  ) {
    return { alerted: false, reason: "already alerted" };
  }

  const hours = Math.floor(quietMs / 3_600_000);
  const mins = Math.round((quietMs % 3_600_000) / 60_000);
  await alertOwner(
    "PrimeWillCall: no OTA booking emails have arrived",
    `No inbound reservation email has reached this platform for ${hours}h ${mins}m.\n\n` +
      `Last one: ${newest.received_at}\n\n` +
      `OTA email normally arrives through the day, so this usually means the intake ` +
      `itself is broken rather than that nobody booked. Check, in this order:\n` +
      `  1. The forwarding rule on the reservations mailbox.\n` +
      `  2. The MX record on the Resend inbound domain.\n` +
      `  3. The Resend webhook (is it still pointed at email-inbound, is it failing?).\n\n` +
      `Bookings made in this window are NOT on the manifest.`,
    `PrimeWillCall ALERT: no OTA booking emails for ${hours}h ${mins}m. ` +
      `Check the mailbox forwarding, the MX record and the Resend webhook.`,
  );
  await sb
    .from("inbound_email_settings")
    .update({ last_silence_alert_at: new Date().toISOString() })
    .eq("id", true);
  return { alerted: true };
}

Deno.serve(withSentry("email-inbound-sweep", async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET) return json({ error: "server not configured: set CRON_SECRET" }, 503);
  if ((req.headers.get("x-cron-secret") ?? "") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const { data: settingsRow } = await sb
    .from("inbound_email_settings")
    .select("alerts_enabled, silence_minutes, quiet_from_hour, quiet_to_hour, max_attempts, last_silence_alert_at")
    .eq("id", true)
    .maybeSingle();
  const s: Settings = settingsRow ?? {
    alerts_enabled: true,
    silence_minutes: 180,
    quiet_from_hour: 22,
    quiet_to_hour: 8,
    max_attempts: 5,
    last_silence_alert_at: null,
  };

  // 1. Retry what is unfinished. Oldest first: the guest who has been waiting
  // longest is the one most likely to turn up at a desk that expects nobody.
  const cutoff = new Date(Date.now() - RETRY_AFTER_MINUTES * 60_000).toISOString();
  const { data: pending } = await sb
    .from("inbound_emails")
    .select("id, provider_email_id, subject, raw_text, to_addresses, legacy_company_id, attempts")
    .in("status", ["received", "failed"])
    .lt("attempts", s.max_attempts)
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${cutoff}`)
    .order("received_at", { ascending: true })
    .limit(BATCH);

  const outcome: Record<string, number> = {};
  for (const row of (pending ?? []) as PendingRow[]) {
    const status = await retry(row, s.max_attempts);
    outcome[status] = (outcome[status] ?? 0) + 1;
  }

  // 2. Then ask the question no row can answer.
  const silence = await checkSilence(s);

  return json({ ok: true, retried: pending?.length ?? 0, outcome, silence }, 200);
}));
