// Scheduled-message dispatcher: the "cron worker" behind messaging waits, and
// the SINGLE place that calls Twilio for automations. A pg_cron job hits this
// once a minute.
//
// HARD SPEND GUARDRAIL: before sending, it computes how many messages were sent
// in the trailing hour and never lets the total exceed messaging_settings
// .sms_hourly_cap (default 100). Overflow stays 'pending' (delayed, not dropped)
// and drains on later runs. When the cap actively throttles work, it logs a
// messaging_alerts row and alerts: an email via Resend to alert_email (primary)
// and/or an SMS to alert_phone. This is the backstop that makes a runaway
// impossible.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
// TWILIO_WHATSAPP_FROM, CRON_SECRET, RESEND_API_KEY (for the email alert).
// SUPABASE_URL + SERVICE_ROLE auto-injected.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const SMS_FROM = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
const WHATSAPP_FROM_RAW = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const TWILIO_MESSAGES = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
const DEFAULT_CAP = 100;
const BATCH = 50;
const HOUR_MS = 3_600_000;

interface ScheduledMessage {
  id: string;
  to_phone: string;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
}

function whatsappFrom(): string {
  const raw = WHATSAPP_FROM_RAW.trim().replace(/^whatsapp:/i, "");
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${raw}`;
}

async function twilioSend(
  params: URLSearchParams,
): Promise<{ ok: boolean; sid?: string; status?: string; error?: string }> {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    return { ok: false, error: "Twilio credentials not configured" };
  }
  try {
    const res = await fetch(TWILIO_MESSAGES, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const json = (await res.json()) as { sid?: string; status?: string; message?: string };
    if (res.status === 201 && json.sid) {
      return { ok: true, sid: json.sid, status: json.status ?? "queued" };
    }
    return { ok: false, error: json.message ?? `Twilio HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function sendOne(
  row: ScheduledMessage,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  if (row.channel === "sms") {
    if (!SMS_FROM) return { ok: false, error: "TWILIO_FROM_NUMBER not configured" };
    return twilioSend(
      new URLSearchParams({ To: row.to_phone, From: SMS_FROM, Body: row.body ?? "" }),
    );
  }
  const from = whatsappFrom();
  if (!from) return { ok: false, error: "TWILIO_WHATSAPP_FROM not configured" };
  if (!row.whatsapp_content_sid) return { ok: false, error: "No WhatsApp template" };
  const params = new URLSearchParams({
    To: `whatsapp:${row.to_phone}`,
    From: `whatsapp:${from}`,
    ContentSid: row.whatsapp_content_sid,
  });
  if (row.whatsapp_variables && Object.keys(row.whatsapp_variables).length > 0) {
    params.set("ContentVariables", JSON.stringify(row.whatsapp_variables));
  }
  return twilioSend(params);
}

/** Send an email via Resend (used for the cap alert). Returns ok. */
async function sendResendEmail(
  from: string,
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
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Count messages already sent in the trailing hour (drives the cap). */
async function sentLastHour(db: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const { count } = await db
    .from("scheduled_messages")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", since);
  return count ?? 0;
}

/** Count messages due to send right now. */
async function dueNow(db: SupabaseClient): Promise<number> {
  const { count } = await db
    .from("scheduled_messages")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("send_at", new Date().toISOString());
  return count ?? 0;
}

/**
 * Fire an alert when the cap is actively holding work back. Deduped to at most
 * once per hour via messaging_settings.alert_last_sent_at. Logs always (when not
 * deduped) and texts alert_phone if configured. The alert SMS is operational and
 * sent directly.
 */
async function alertCapHit(
  db: SupabaseClient,
  settings: {
    alert_phone: string | null;
    alert_email: string | null;
    alert_email_from: string | null;
    alert_last_sent_at: string | null;
  },
  sent: number,
  queuedRemaining: number,
): Promise<void> {
  const last = settings.alert_last_sent_at ? new Date(settings.alert_last_sent_at).getTime() : 0;
  if (Date.now() - last < HOUR_MS) return; // already alerted this hour

  // "What is triggering": break down the held queue by product + source.
  const { data: sample } = await db
    .from("scheduled_messages")
    .select("booking:bookings(source_channel, product:business_tours(name))")
    .eq("status", "pending")
    .lte("send_at", new Date().toISOString())
    .limit(200);
  const counts = new Map<string, number>();
  for (const r of sample ?? []) {
    const b = (r as { booking: { source_channel: string | null; product: { name: string | null } | null } | null }).booking;
    const key = `${b?.product?.name ?? "?"} / ${b?.source_channel ?? "?"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lines = top.map(([k, n]) => `${n}x ${k}`).join("; ") || "n/a";

  let notified = false;

  // Email (Resend) is the primary alert channel.
  if (settings.alert_email && RESEND_API_KEY) {
    const ok = await sendResendEmail(
      settings.alert_email_from ?? "PrimeWillCall Alerts <alerts@alert.primewillcall.com>",
      settings.alert_email,
      `PrimeWillCall: SMS hourly cap hit (${sent}/hr)`,
      `The messaging automations hit the hourly SMS cap.\n\n` +
        `Sent in the last hour: ${sent}\n` +
        `Queued and throttled right now: ${queuedRemaining}\n\n` +
        `What is filling the queue (product / source):\n` +
        top.map(([k, n]) => `  - ${n}x ${k}`).join("\n") +
        `\n\nSending is auto-limited to the cap; nothing was dropped. ` +
        `If this is unexpected, set messaging_settings.automations_enabled = false to stop it.`,
    );
    notified = notified || ok;
  }

  // Optional SMS alert (only if a phone is configured).
  if (settings.alert_phone && SMS_FROM && ACCOUNT_SID && AUTH_TOKEN) {
    const res = await twilioSend(
      new URLSearchParams({
        To: settings.alert_phone,
        From: SMS_FROM,
        Body:
          `PrimeWillCall ALERT: SMS hourly cap hit (${sent} sent/hr). ` +
          `${queuedRemaining} queued and throttled. Top: ${lines}. ` +
          `Automations auto-limited; disable in messaging_settings if unexpected.`,
      }),
    );
    notified = notified || res.ok;
  }

  await db.from("messaging_alerts").insert({
    kind: "hourly_cap",
    sent_last_hour: sent,
    queued_remaining: queuedRemaining,
    notified,
    detail: { top: Object.fromEntries(top) },
  });
  await db.from("messaging_settings").update({ alert_last_sent_at: new Date().toISOString() }).eq("id", true);
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: settings } = await db
    .from("messaging_settings")
    .select("sms_hourly_cap, alert_phone, alert_email, alert_email_from, alert_last_sent_at")
    .eq("id", true)
    .maybeSingle();
  const cap = settings?.sms_hourly_cap ?? DEFAULT_CAP;
  const alertCfg = {
    alert_phone: settings?.alert_phone ?? null,
    alert_email: settings?.alert_email ?? null,
    alert_email_from: settings?.alert_email_from ?? null,
    alert_last_sent_at: settings?.alert_last_sent_at ?? null,
  };

  const due = await dueNow(db);
  if (due === 0) {
    return Response.json({ claimed: 0, sent: 0, failed: 0, capped: false });
  }

  const alreadySent = await sentLastHour(db);
  const budget = Math.max(0, cap - alreadySent);

  // The cap is actively throttling if there's more due work than budget.
  if (due > budget) {
    await alertCapHit(db, alertCfg, alreadySent, Math.max(0, due - budget));
  }
  if (budget <= 0) {
    return Response.json({ claimed: 0, sent: 0, failed: 0, capped: true, cap, sentLastHour: alreadySent });
  }

  // Claim only up to the remaining budget so we can never exceed the cap.
  const { data, error } = await db.rpc("claim_due_scheduled_messages", {
    batch: Math.min(BATCH, budget),
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as ScheduledMessage[];

  let sent = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    const result = await sendOne(row);
    if (result.ok) {
      sent += 1;
      await db
        .from("scheduled_messages")
        .update({ status: "sent", sent_at: nowIso, provider_sid: result.sid ?? null })
        .eq("id", row.id);
    } else {
      failed += 1;
      await db
        .from("scheduled_messages")
        .update({ status: "failed", last_error: result.error ?? "unknown error" })
        .eq("id", row.id);
    }
  }

  return Response.json({
    claimed: rows.length,
    sent,
    failed,
    capped: due > budget,
    cap,
    sentLastHour: alreadySent + sent,
  });
});
