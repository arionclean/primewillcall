import { normalizeUsPhone } from "@/lib/sms/format";
import { getTwilioFromNumber, sendTwilioSms } from "@/lib/sms/twilio";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export type SmsDirection = "inbound" | "outbound";

export interface SmsLogEntry {
  direction: SmsDirection;
  from_number: string;
  to_number: string;
  body: string;
  tag?: string | null;
  status?: string | null;
  twilio_sid?: string | null;
  error?: string | null;
}

export async function logSmsMessage(entry: SmsLogEntry) {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("sms_messages").insert(entry);
  if (error) {
    // Logging must never break the send/receive path.
    console.error("Failed to log SMS message:", error.message);
  }
}

export async function isOptedOut(phoneNumber: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
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

export async function setOptOut(phoneNumber: string, optedOut: boolean, reason: string) {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("sms_opt_outs")
    .upsert({ phone_number: phoneNumber, opted_out: optedOut, reason });
  if (error) {
    console.error("Failed to update SMS opt-out:", error.message);
  }
}

const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

/** Twilio's standard opt-out/opt-in keywords, matched on the whole message. */
export function classifyOptKeyword(body: string): "opt_out" | "opt_in" | null {
  const keyword = body.trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(keyword)) {
    return "opt_out";
  }
  if (OPT_IN_KEYWORDS.has(keyword)) {
    return "opt_in";
  }
  return null;
}

export interface SendSmsInput {
  to: string;
  body: string;
  tag?: string;
  from?: string;
}

export interface SendSmsResult {
  sent: boolean;
  status: string;
  sid?: string;
  reason?: string;
}

/**
 * Send an SMS and record it in sms_messages.
 * US-only and opt-out aware; failures are logged, not thrown.
 */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const to = normalizeUsPhone(input.to);
  if (!to) {
    return { sent: false, status: "skipped", reason: "Only US phone numbers are supported" };
  }
  if (await isOptedOut(to)) {
    return { sent: false, status: "skipped", reason: "Recipient has opted out" };
  }

  const from = (input.from ? normalizeUsPhone(input.from) : null) ?? getTwilioFromNumber();

  try {
    const result = await sendTwilioSms({ to, from, body: input.body });
    await logSmsMessage({
      direction: "outbound",
      from_number: from,
      to_number: to,
      body: input.body,
      tag: input.tag ?? null,
      status: result.status,
      twilio_sid: result.sid,
    });
    return { sent: true, status: result.status, sid: result.sid };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logSmsMessage({
      direction: "outbound",
      from_number: from,
      to_number: to,
      body: input.body,
      tag: input.tag ?? null,
      status: "failed",
      error: message,
    });
    return { sent: false, status: "failed", reason: message };
  }
}

export interface BookingConfirmationInput {
  phone: string;
  firstName: string;
  productName: string;
  confirmationId: string;
}

/**
 * New-booking SMS flow, ported from the Xano "City tour campaign_v1" trigger
 * on bookings insert: an intro message the first time we ever text a number,
 * then the ticket/meeting-point link. Call this after creating a booking.
 */
export async function sendBookingConfirmationSms(
  input: BookingConfirmationInput,
): Promise<SendSmsResult[]> {
  const to = normalizeUsPhone(input.phone);
  if (!to) {
    return [{ sent: false, status: "skipped", reason: "Only US phone numbers are supported" }];
  }

  const supabase = getSupabaseAdminClient();
  const { count, error } = await supabase
    .from("sms_messages")
    .select("id", { count: "exact", head: true })
    .eq("to_number", to);
  if (error) {
    console.error("Failed to count prior SMS messages:", error.message);
  }

  const results: SendSmsResult[] = [];

  if (!count) {
    results.push(
      await sendSms({
        to,
        body: `Hi ${input.firstName}, it's Jessi from ${input.productName}`,
        tag: "optIn",
      }),
    );
  }

  const bookingLinkBase = process.env.BOOKING_LINK_BASE_URL ?? "https://bked.io/booking";
  results.push(
    await sendSms({
      to,
      body: `Use this link to see your ticket and the meeting point information: ${bookingLinkBase}/${input.confirmationId} (Text STOP to unsubscribe).`,
      tag: "bookingConfirmation",
    }),
  );

  return results;
}
