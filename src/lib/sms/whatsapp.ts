import type { SupabaseClient } from "@supabase/supabase-js";

import type { SendSmsResult } from "@/lib/sms/messages";
import { getTwilioCredentials } from "@/lib/sms/twilio";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

function getWhatsappFrom(): string | null {
  const raw = process.env.TWILIO_WHATSAPP_FROM?.trim();
  if (!raw) return null;
  const number = raw.replace(/^whatsapp:/i, "");
  return number.startsWith("+") ? number : `+${number}`;
}

/**
 * Send an approved WhatsApp template (Twilio Content API sid) and log it in
 * whatsapp_messages. Business-initiated WhatsApp requires approved templates,
 * so free-form bodies are not supported here.
 */
export async function sendWhatsappTemplateMessage(input: {
  to: string;
  contentSid: string;
  contentVariables: Record<string, string>;
  businessId?: string | null;
  bookingId?: string | null;
  customerId?: string | null;
  sentByStaffId?: string | null;
}): Promise<SendSmsResult> {
  const from = getWhatsappFrom();
  if (!from) {
    return { sent: false, status: "failed", reason: "TWILIO_WHATSAPP_FROM not configured" };
  }
  if (!input.contentSid) {
    return { sent: false, status: "failed", reason: "No WhatsApp template selected" };
  }

  const { accountSid, authToken } = getTwilioCredentials();
  const params = new URLSearchParams({
    To: `whatsapp:${input.to}`,
    From: `whatsapp:${from}`,
    ContentSid: input.contentSid,
  });
  if (Object.keys(input.contentVariables).length > 0) {
    params.set("ContentVariables", JSON.stringify(input.contentVariables));
  }

  let sid: string | null = null;
  let status = "failed";
  let errorMessage: string | null = null;
  try {
    const response = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const result = (await response.json()) as { sid?: string; status?: string; message?: string };
    if (response.status === 201 && result.sid) {
      sid = result.sid;
      status = result.status ?? "queued";
    } else {
      errorMessage = result.message ?? `Twilio request failed with status ${response.status}`;
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  // Log into the existing whatsapp_messages table (outbound-only by design).
  const db = getSupabaseAdminClient() as unknown as SupabaseClient | null;
  if (db) {
    const { error } = await db.from("whatsapp_messages").insert({
      to_phone: input.to,
      from_phone: from,
      body: `[template ${input.contentSid}] ${JSON.stringify(input.contentVariables)}`,
      status,
      twilio_sid: sid,
      error: errorMessage,
      business_id: input.businessId ?? null,
      booking_id: input.bookingId ?? null,
      customer_id: input.customerId ?? null,
      sent_by_staff_id: input.sentByStaffId ?? null,
    });
    if (error) {
      console.error("Failed to log WhatsApp message:", error.message);
    }
  }

  if (errorMessage) {
    return { sent: false, status: "failed", reason: errorMessage };
  }
  return { sent: true, status, sid: sid ?? undefined };
}
