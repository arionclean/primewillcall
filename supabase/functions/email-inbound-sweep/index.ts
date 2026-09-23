// The Mailroom's safety net. pg_cron calls this every 5 minutes.
//
// Three jobs, and the last one is the reason this exists at all:
//
//   1. Retry. Any inbound_emails row that is still unfinished gets another pass.
//      Resend keeps the email, and both the parse and the booking upsert are safe to
//      repeat, so a retry is free. A row that runs out of attempts goes to 'failed',
//      where a person owns it (the Mailroom's Retry is the way back in).
//
//   2. Tell a person, once. Every row that failed, and every booking the Mailroom
//      made with a detail it could not read (no guest count, no name), is claimed by
//      mailroom_claim_alerts and reported by text and email. Claimed before anything
//      is sent, so two runs can never report the same email twice; released again if
//      nothing could be sent, so a Twilio or Resend hiccup does not swallow it.
//
//   3. Notice the silence. Every row-level check in the world cannot tell you about
//      the email that never arrived. A deleted forwarding rule, an MX record edited
//      during some unrelated DNS change, a suspended Resend domain: the intake goes
//      quiet and every screen looks normal, while real guests hold reservations this
//      platform has never heard of. So: if email HAS been flowing and then stops for
//      longer than inbound_email_settings.silence_minutes during the hours it should
//      be flowing, alert. This is what Make's execution history could not do either,
//      because an execution that never happens leaves nothing to look at.
//
// The silence alarm is deliberately one-shot per silence_minutes window
// (last_silence_alert_at), and asleep overnight (quiet_from_hour / quiet_to_hour, New
// York), because an alert that cries every five minutes at 4am gets muted, and a
// muted alarm is no alarm.
//
// And the one failure none of that can report, this job itself not running, is
// watched from outside: every scheduled run checks in with a Sentry cron monitor
// (withCronMonitor), which opens an issue when the check-ins stop.
//
// Auth: x-cron-secret must equal CRON_SECRET, like the other cron functions. The
// Mailroom's Retry button (mailroom_retry) calls this too, with
// {"reason": "retry"}, to run a pass now instead of in up to five minutes; that run
// does not check in, so it can never hide a stopped schedule.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { withCronMonitor, withSentry } from "../_shared/sentry.ts";
import { BUSINESS_TZ } from "../_shared/ny-time.ts";
import { type InboundRow, runPass } from "../_shared/inbound-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const SMS_FROM = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://primewillcall.vercel.app")
  .replace(/\/+$/, "");

/** The Mailroom screen. Owner only, and linked from nowhere in the app: alerts are
 *  how a person gets there. */
const MAILROOM_URL = `${APP_URL}/admin/mailroom`;

/** The words for the warning codes runPass records (see warningsFor). */
const WARNING_TEXT: Record<string, string> = {
  no_guest_count: "no guest count",
  guest_count_mismatch: "a guest count that does not match the email's total",
  no_guest_name: "no guest name",
  no_channel: "no sales channel",
};

/** Rows per run. A pass can call the AI product match, so this is a budget, not a cap. */
const BATCH = 20;
/** Leave a pass alone for this long after it starts before trying the row again. */
const RETRY_AFTER_MINUTES = 5;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

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

type PendingRow = InboundRow & { attempts: number; received_at: string };

type AlertRow = {
  id: string;
  status: string;
  subject: string | null;
  error: string | null;
  warnings: string[] | null;
  received_at: string;
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

/** "Sep 23, 8:14 AM" in New York, for an alert a person reads on a phone. */
function nyWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** True while the silence alarm is asleep. Handles a window that wraps midnight. */
function inQuietHours(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

async function sendResendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
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
 * urgency; a missed booking is worth waking someone for. True when either went out.
 */
async function alertOwner(
  subject: string,
  detail: string,
  sms: string,
): Promise<boolean> {
  const { data: settings } = await sb
    .from("messaging_settings")
    .select("alert_email, alert_phone")
    .eq("id", true)
    .maybeSingle();
  let notified = false;
  if (settings?.alert_email) {
    notified = await sendResendEmail(settings.alert_email, subject, detail) ||
      notified;
  }
  if (settings?.alert_phone) {
    notified = await sendSmsAlert(settings.alert_phone, sms) || notified;
  }
  return notified;
}

/** Job 1. Returns how many rows ended in each status. */
async function retryPending(s: Settings): Promise<Record<string, number>> {
  // A row can sit at 'received' with its attempts already spent if max_attempts was
  // lowered under it. Hand those to a person instead of leaving them nowhere.
  await sb
    .from("inbound_emails")
    .update({ status: "failed" })
    .eq("status", "received")
    .gte("attempts", s.max_attempts);

  // Claimed, not just selected: the claim stamps last_attempt_at under
  // FOR UPDATE SKIP LOCKED, so a Retry-button run and a scheduled run can never
  // both work the same email.
  const { data: pending, error } = await sb.rpc("mailroom_claim_pending", {
    p_limit: BATCH,
    p_max_attempts: s.max_attempts,
    p_retry_after_minutes: RETRY_AFTER_MINUTES,
  });
  if (error) throw new Error(`claim pending: ${error.message}`);

  // Oldest first: the guest who has been waiting longest is the one most likely to
  // turn up at a desk that expects nobody.
  const rows = ((pending ?? []) as PendingRow[]).sort((a, b) =>
    a.received_at.localeCompare(b.received_at)
  );
  const outcome: Record<string, number> = {};
  for (const row of rows) {
    const status = await runPass(sb, row, s.max_attempts);
    outcome[status] = (outcome[status] ?? 0) + 1;
  }
  return outcome;
}

/** Job 2. Returns how many rows were reported. */
async function alertClaimed(s: Settings): Promise<number> {
  if (!s.alerts_enabled) return 0;

  const { data, error } = await sb.rpc("mailroom_claim_alerts");
  if (error) throw new Error(`claim alerts: ${error.message}`);
  const rows = (data ?? []) as AlertRow[];
  if (rows.length === 0) return 0;

  const failed = rows.filter((r) => r.status === "failed");
  const partial = rows.filter((r) => r.status !== "failed");
  const linkFor = (r: AlertRow) => `${MAILROOM_URL}?email=${r.id}`;
  const problem = (r: AlertRow) =>
    r.status === "failed"
      ? r.error ?? "It could not be processed"
      : `Booked with ${
        (r.warnings ?? []).map((w) => WARNING_TEXT[w] ?? w).join(", ")
      }`;

  const subject = rows.length > 1
    ? `Mailroom: ${rows.length} booking emails need a look`
    : failed.length === 1
    ? "Mailroom: a booking email could not be processed"
    : "Mailroom: a booking came in with missing details";

  const lines = rows.map((r) =>
    `- ${r.subject ?? "(no subject)"}, received ${nyWhen(r.received_at)}\n` +
    `  ${problem(r)}\n` +
    `  ${linkFor(r)}`
  );
  const detail = [
    failed.length > 0
      ? `${failed.length} booking email${failed.length === 1 ? "" : "s"} could not be ` +
        `processed. The guest may hold a reservation that is NOT on the manifest.`
      : null,
    partial.length > 0
      ? `${partial.length} booking${partial.length === 1 ? " was" : "s were"} made with ` +
        `a detail the email did not give. Check ${
          partial.length === 1 ? "it" : "them"
        } on the manifest.`
      : null,
    "",
    ...lines,
    "",
    "Open the link to read the email and what each step did, then Retry it, set it " +
    "aside, or book the guest by hand from /schedule.",
  ].filter((l) => l !== null).join("\n");

  const first = rows[0];
  const sms = `PrimeWillCall Mailroom: ${
    [
      failed.length > 0 ? `${failed.length} booking email${failed.length === 1 ? "" : "s"} failed` : null,
      partial.length > 0 ? `${partial.length} booked with missing details` : null,
    ].filter(Boolean).join(", ")
  }. ${problem(first).slice(0, 90)}. ${
    rows.length === 1 ? linkFor(first) : MAILROOM_URL
  }`;

  const notified = await alertOwner(subject, detail, sms);
  if (!notified) {
    // Nothing went out (no channel configured, or both providers failed). Release
    // the claim so the next run tries again rather than the alert being lost.
    await sb
      .from("inbound_emails")
      .update({ alert_sent_at: null })
      .in("id", rows.map((r) => r.id));
    return 0;
  }
  return rows.length;
}

/** Job 3. The pipeline has gone quiet. Returns true when an alert was raised. */
async function checkSilence(
  s: Settings,
): Promise<{ alerted: boolean; reason?: string }> {
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
  if (!newest?.received_at) {
    return { alerted: false, reason: "no email ever received" };
  }

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
    "Mailroom: no OTA booking emails have arrived",
    `No reservation email has reached the Mailroom for ${hours}h ${mins}m.\n\n` +
      `Last one: ${nyWhen(newest.received_at)} (New York)\n\n` +
      `OTA email normally arrives through the day, so this usually means the intake ` +
      `itself is broken rather than that nobody booked. Check, in this order:\n` +
      `  1. The forwarding rule on the reservations mailbox.\n` +
      `  2. The MX record on the Resend inbound domain.\n` +
      `  3. The Resend webhook (is it still pointed at email-inbound, is it failing?).\n\n` +
      `Bookings made in this window are NOT on the manifest.\n${MAILROOM_URL}`,
    `PrimeWillCall Mailroom: no OTA booking emails for ${hours}h ${mins}m. ` +
      `Check the mailbox forwarding, the MX record and the Resend webhook.`,
  );
  await sb
    .from("inbound_email_settings")
    .update({ last_silence_alert_at: new Date().toISOString() })
    .eq("id", true);
  return { alerted: true };
}

async function sweep() {
  const { data: settingsRow } = await sb
    .from("inbound_email_settings")
    .select(
      "alerts_enabled, silence_minutes, quiet_from_hour, quiet_to_hour, max_attempts, last_silence_alert_at",
    )
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

  const outcome = await retryPending(s);
  // Alert after the retries, so a row that just ran out of attempts is reported in
  // this run rather than the next.
  const alerted = await alertClaimed(s);
  // Then ask the question no row can answer.
  const silence = await checkSilence(s);
  return { ok: true, outcome, alerted, silence };
}

Deno.serve(withSentry("email-inbound-sweep", async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "POST only" }, 405);
  }
  if (!CRON_SECRET) {
    return json({ error: "server not configured: set CRON_SECRET" }, 503);
  }
  // Outside the heartbeat on purpose: a run refused here is a schedule that is not
  // working, which is exactly what the monitor must see as a missed check-in.
  if ((req.headers.get("x-cron-secret") ?? "") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({})) as { reason?: string };
  if (body?.reason === "retry") {
    return json(await sweep(), 200);
  }
  return json(
    await withCronMonitor("mailroom-sweep", "*/5 * * * *", sweep),
    200,
  );
}));
