// Scheduled-message dispatcher: the "cron worker" behind messaging waits.
//
// A pg_cron job hits this once a minute. It atomically claims the due rows from
// public.scheduled_messages (via claim_due_scheduled_messages, which flips them
// to 'sending' with FOR UPDATE SKIP LOCKED so concurrent runs never double-send),
// sends each through Twilio, and marks it 'sent' or 'failed'. Immediate messages
// never reach here; only "wait N then send" actions are enqueued by
// runNewBookingRules in the Next app.
//
// Secrets (Supabase function secrets): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM_NUMBER (SMS sender), TWILIO_WHATSAPP_FROM (WhatsApp sender), and
// CRON_SECRET (the shared token pg_cron sends in x-cron-secret).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const SMS_FROM = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
const WHATSAPP_FROM_RAW = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const TWILIO_MESSAGES = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
const BATCH = 50;

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

Deno.serve(async (req) => {
  // Only the scheduler (which knows the shared secret) may run this.
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data, error } = await db.rpc("claim_due_scheduled_messages", { batch: BATCH });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
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

  return Response.json({ claimed: rows.length, sent, failed });
});
