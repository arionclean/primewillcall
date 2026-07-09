import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeUsPhone } from "@/lib/sms/format";
import { getMessageTemplates, renderTemplate } from "@/lib/sms/templates";
import { getTwilioFromNumber, sendTwilioSms } from "@/lib/sms/twilio";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export type SmsDirection = "inbound" | "outbound";

/**
 * Service-role client for the SMS tables. sms_messages/sms_opt_outs are newer
 * than the generated Database types, so this is intentionally untyped until
 * database.types.ts is regenerated.
 */
function getSmsDb(): SupabaseClient | null {
  return getSupabaseAdminClient() as unknown as SupabaseClient | null;
}

export interface SmsLogEntry {
  direction: SmsDirection;
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

/**
 * Link a message to a customer by phone (same idea as Xano's
 * "add to message logs" resolving contacts). Phones in customers come from
 * the Xano import, so try the common format variants.
 */
async function findCustomerByPhone(
  phone: string,
): Promise<{ id: string; business_id: string | null } | null> {
  const normalized = normalizeUsPhone(phone);
  const supabase = getSmsDb();
  if (!normalized || !supabase) {
    return null;
  }
  const national = normalized.slice(2);
  const { data, error } = await supabase
    .from("customers")
    .select("id, business_id")
    .in("phone", [normalized, national, `1${national}`])
    .limit(1);
  if (error) {
    console.error("Failed to look up customer by phone:", error.message);
    return null;
  }
  return (data?.[0] as { id: string; business_id: string | null } | undefined) ?? null;
}

export async function logSmsMessage(entry: SmsLogEntry) {
  const supabase = getSmsDb();
  if (!supabase) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not configured; SMS message not logged.");
    return;
  }

  if (!entry.customer_id) {
    const counterpart = entry.direction === "inbound" ? entry.from_phone : entry.to_phone;
    const customer = await findCustomerByPhone(counterpart);
    if (customer) {
      entry = {
        ...entry,
        customer_id: customer.id,
        business_id: entry.business_id ?? customer.business_id,
      };
    }
  }

  const { error } = await supabase.from("sms_messages").insert(entry);
  if (error) {
    // Logging must never break the send/receive path.
    console.error("Failed to log SMS message:", error.message);
  }
}

export async function isOptedOut(phoneNumber: string): Promise<boolean> {
  const supabase = getSmsDb();
  if (!supabase) {
    return false;
  }
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
  const supabase = getSmsDb();
  if (!supabase) {
    return;
  }
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
  businessId?: string | null;
  bookingId?: string | null;
  sentByStaffId?: string | null;
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
  if (!getSmsDb()) {
    return { sent: false, status: "failed", reason: "SUPABASE_SERVICE_ROLE_KEY not configured" };
  }
  const to = normalizeUsPhone(input.to);
  if (!to) {
    return { sent: false, status: "skipped", reason: "Only US phone numbers are supported" };
  }
  if (await isOptedOut(to)) {
    return { sent: false, status: "skipped", reason: "Recipient has opted out" };
  }

  const from = (input.from ? normalizeUsPhone(input.from) : null) ?? getTwilioFromNumber();
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

export interface BookingConfirmationInput {
  phone: string;
  firstName: string;
  productName: string;
  confirmationId: string;
  businessId?: string | null;
  bookingId?: string | null;
}

/**
 * New-booking SMS flow, ported from the Xano "City tour campaign_v1" trigger
 * on bookings insert: an intro message the first time we ever text a number,
 * then the ticket/meeting-point link. Call this after creating a booking.
 * Message wording comes from message_templates (editable in /admin/messaging).
 */
export async function sendBookingConfirmationSms(
  input: BookingConfirmationInput,
): Promise<SendSmsResult[]> {
  const to = normalizeUsPhone(input.phone);
  if (!to) {
    return [{ sent: false, status: "skipped", reason: "Only US phone numbers are supported" }];
  }
  const supabase = getSmsDb();
  if (!supabase) {
    return [
      { sent: false, status: "failed", reason: "SUPABASE_SERVICE_ROLE_KEY not configured" },
    ];
  }

  const { count, error } = await supabase
    .from("sms_messages")
    .select("id", { count: "exact", head: true })
    .eq("to_phone", to);
  if (error) {
    console.error("Failed to count prior SMS messages:", error.message);
  }

  const bookingLinkBase = process.env.BOOKING_LINK_BASE_URL ?? "https://bked.io/booking";
  const templates = await getMessageTemplates([
    "sms_booking_intro",
    "sms_booking_confirmation",
  ]);
  const vars = {
    first_name: input.firstName,
    product_name: input.productName,
    booking_link: `${bookingLinkBase}/${input.confirmationId}`,
  };

  const linkFields = { businessId: input.businessId, bookingId: input.bookingId };
  const results: SendSmsResult[] = [];

  const intro = templates.sms_booking_intro;
  if (!count && intro.isActive) {
    results.push(
      await sendSms({
        to,
        body: renderTemplate(intro.body, vars),
        tag: "optIn",
        ...linkFields,
      }),
    );
  }

  const confirmation = templates.sms_booking_confirmation;
  if (confirmation.isActive) {
    results.push(
      await sendSms({
        to,
        body: renderTemplate(confirmation.body, vars),
        tag: "bookingConfirmation",
        ...linkFields,
      }),
    );
  }

  return results;
}
