import { NextRequest, NextResponse } from "next/server";

import { normalizeUsPhone } from "@/lib/sms/format";
import { classifyOptKeyword, logSmsMessage, setOptOut } from "@/lib/sms/messages";
import { validateTwilioSignature } from "@/lib/sms/twilio";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// While Xano coexists, mirror every webhook to its endpoint so notifications
// and reply handling there keep working. Set XANO_SMS_FORWARD_URL="" to stop.
const XANO_FORWARD_DEFAULT =
  "https://xmhi-aj9d-cnsb.n7.xano.io/api:M7vqYZvJ/receive/sms_respose_twilio";

async function forwardToXano(params: Record<string, string>) {
  const url = process.env.XANO_SMS_FORWARD_URL ?? XANO_FORWARD_DEFAULT;
  if (!url) {
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("Failed to forward SMS webhook to Xano:", error);
  }
}

function twimlResponse() {
  return new NextResponse(EMPTY_TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function webhookUrl(request: NextRequest): string {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (base) {
    return `${base.replace(/\/$/, "")}/api/webhooks/twilio/sms`;
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}/api/webhooks/twilio/sms`;
}

/**
 * Twilio inbound-SMS webhook (configure it as the Messaging webhook on the
 * Twilio number). Port of the Xano endpoint POST /api:M7vqYZvJ/receive/sms_respose_twilio.
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") {
      params[key] = value;
    }
  });

  // The Xano endpoint was unauthenticated; here we verify the request really
  // came from Twilio. Set TWILIO_VALIDATE_SIGNATURE=false only for local dev.
  if (process.env.TWILIO_VALIDATE_SIGNATURE !== "false") {
    const signature = request.headers.get("x-twilio-signature");
    if (!validateTwilioSignature(webhookUrl(request), params, signature)) {
      return new NextResponse("Invalid Twilio signature", { status: 403 });
    }
  }

  // Keep Xano's copy of the flow alive during coexistence.
  await forwardToXano(params);

  // Same guard the Xano endpoint used: only handle real inbound messages.
  if (params.SmsStatus !== "received") {
    return twimlResponse();
  }

  const body = params.Body ?? "";

  await logSmsMessage({
    direction: "inbound",
    from_number: normalizeUsPhone(params.From) ?? params.From ?? "",
    to_number: normalizeUsPhone(params.To) ?? params.To ?? "",
    body,
    status: "received",
    twilio_sid: params.MessageSid ?? null,
  });

  const optAction = classifyOptKeyword(body);
  if (optAction) {
    const phone = normalizeUsPhone(params.From) ?? params.From;
    if (phone) {
      await setOptOut(phone, optAction === "opt_out", body.trim().toUpperCase());
    }
  }

  // TODO: port the Xano "analyze inbound message_v2" follow-up (cancel pending
  // flow timers, classify rateAsk replies with an LLM, create review records,
  // send the Google-review ask) once contacts/bookings/reviews exist in Supabase.

  return twimlResponse();
}
