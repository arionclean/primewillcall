/**
 * Shared SMS primitives for the edge functions (twilio-inbound-sms, sms-send, sms-sync).
 *
 * This is the Supabase-side home of what used to live in src/lib/sms/*. Twilio
 * credentials live here as function secrets and nowhere else, so Vercel no longer
 * needs TWILIO_* env vars at all.
 *
 * Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
export const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const FROM_NUMBER_RAW = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";

export const TWILIO_HOST = "https://api.twilio.com";

/** Service-role client. The SMS tables have no write RLS; there is no user session here. */
export const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/** Basic-auth header for the Twilio REST API. */
export function twilioAuthHeader(): string {
  return `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`;
}

/* ------------------------------------------------------------------ phones */

/**
 * Normalize a US phone to E.164 (+1XXXXXXXXXX).
 * Null for anything that is not a valid 10-digit US number, which callers treat
 * as "do not send" (the legacy Xano flow is US-only).
 */
export function normalizeUsPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Phones came from the Xano import in mixed formats, so match the common variants. */
export function phoneVariants(e164: string): string[] {
  const national = e164.slice(2);
  return [e164, national, `1${national}`];
}

export function twilioFromNumber(): string {
  const from = normalizeUsPhone(FROM_NUMBER_RAW);
  if (!from) {
    throw new Error(
      "Missing or invalid TWILIO_FROM_NUMBER. Set it to the Twilio sender number, e.g. +18774608995.",
    );
  }
  return from;
}

/* --------------------------------------------------------------- logging */

export interface SmsLogEntry {
  direction: "inbound" | "outbound";
  from_phone: string;
  to_phone: string;
  body: string;
  tag?: string | null;
  status?: string | null;
  twilio_sid?: string | null;
  error?: string | null;
  business_id?: string | null;
  customer_id?: string | null;
  booking_id?: string | null;
  sent_by_staff_id?: string | null;
}

/** Link a message to a customer by phone, the way Xano's "add to message logs" did. */
export async function findCustomerByPhone(
  phone: string,
): Promise<{ id: string; business_id: string | null } | null> {
  const normalized = normalizeUsPhone(phone);
  if (!normalized) return null;
  const { data, error } = await db
    .from("customers")
    .select("id, business_id")
    .in("phone", phoneVariants(normalized))
    .limit(1);
  if (error) {
    console.error("Failed to look up customer by phone:", error.message);
    return null;
  }
  return data?.[0] ?? null;
}

export async function logSmsMessage(entry: SmsLogEntry): Promise<void> {
  let row = entry;
  if (!row.customer_id) {
    const counterpart = row.direction === "inbound" ? row.from_phone : row.to_phone;
    const customer = await findCustomerByPhone(counterpart);
    if (customer) {
      row = {
        ...row,
        customer_id: customer.id,
        business_id: row.business_id ?? customer.business_id,
      };
    }
  }
  const { error } = await db.from("sms_messages").insert(row);
  // Logging must never break the send/receive path.
  if (error) console.error("Failed to log SMS message:", error.message);
}

/* ------------------------------------------------------------- opt in/out */

const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

/** Twilio's standard opt-out/opt-in keywords, matched on the whole message. */
export function classifyOptKeyword(body: string): "opt_out" | "opt_in" | null {
  const keyword = body.trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(keyword)) return "opt_out";
  if (OPT_IN_KEYWORDS.has(keyword)) return "opt_in";
  return null;
}

export async function setOptOut(
  phoneNumber: string,
  optedOut: boolean,
  reason: string,
): Promise<void> {
  const { error } = await db
    .from("sms_opt_outs")
    .upsert({ phone_number: phoneNumber, opted_out: optedOut, reason });
  if (error) console.error("Failed to update SMS opt-out:", error.message);
}

export async function isOptedOut(phoneNumber: string): Promise<boolean> {
  const { data, error } = await db
    .from("sms_opt_outs")
    .select("opted_out")
    .eq("phone_number", phoneNumber)
    .maybeSingle();
  if (error) {
    console.error("Failed to check SMS opt-out:", error.message);
    return false;
  }
  return data?.opted_out ?? false;
}

/* ------------------------------------------------------------------ send */

export interface SendSmsResult {
  sent: boolean;
  status: string;
  sid?: string;
  reason?: string;
}

/** Send one SMS through the Twilio Messages API. Throws Twilio's message on failure. */
async function sendTwilioSms(params: { to: string; from: string; body: string }) {
  if (!ACCOUNT_SID || !AUTH_TOKEN) throw new Error("Twilio credentials not configured");
  const response = await fetch(
    `${TWILIO_HOST}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: params.to, From: params.from, Body: params.body }),
    },
  );
  const result = await response.json() as { sid?: string; status?: string; message?: string };
  if (response.status !== 201) {
    throw new Error(result.message ?? `Twilio request failed with status ${response.status}`);
  }
  return { sid: result.sid ?? "", status: result.status ?? "unknown" };
}

/**
 * Send an SMS and record it in sms_messages.
 * US-only and opt-out aware; failures are logged, not thrown.
 */
export async function sendSms(input: {
  to: string;
  body: string;
  tag?: string | null;
  from?: string | null;
  businessId?: string | null;
  bookingId?: string | null;
  sentByStaffId?: string | null;
}): Promise<SendSmsResult> {
  const to = normalizeUsPhone(input.to);
  if (!to) return { sent: false, status: "skipped", reason: "Only US phone numbers are supported" };
  if (await isOptedOut(to)) return { sent: false, status: "skipped", reason: "Recipient has opted out" };

  const from = (input.from ? normalizeUsPhone(input.from) : null) ?? twilioFromNumber();
  const linkFields = {
    business_id: input.businessId ?? null,
    booking_id: input.bookingId ?? null,
    sent_by_staff_id: input.sentByStaffId ?? null,
  };

  try {
    const result = await sendTwilioSms({ to, from, body: input.body });
    await logSmsMessage({
      direction: "outbound",
      from_phone: from,
      to_phone: to,
      body: input.body,
      tag: input.tag ?? null,
      status: result.status,
      twilio_sid: result.sid,
      ...linkFields,
    });
    return { sent: true, status: result.status, sid: result.sid };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logSmsMessage({
      direction: "outbound",
      from_phone: from,
      to_phone: to,
      body: input.body,
      tag: input.tag ?? null,
      status: "failed",
      error: message,
      ...linkFields,
    });
    return { sent: false, status: "failed", reason: message };
  }
}

/* ------------------------------------------------------------------ http */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

/** The staff UI calls sms-send / sms-sync straight from the browser. */
export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
} as const;
