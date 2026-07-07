import { createHmac, timingSafeEqual } from "node:crypto";

import { normalizeUsPhone } from "@/lib/sms/format";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export function getTwilioCredentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      "Missing Twilio environment variables. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
    );
  }
  return { accountSid, authToken };
}

export function getTwilioFromNumber(): string {
  const from = normalizeUsPhone(process.env.TWILIO_FROM_NUMBER);
  if (!from) {
    throw new Error(
      "Missing or invalid TWILIO_FROM_NUMBER. Set it to the Twilio sender number, e.g. +18774608995.",
    );
  }
  return from;
}

export interface TwilioSendResult {
  sid: string;
  status: string;
}

/**
 * Send one SMS through the Twilio Messages API.
 * Throws with Twilio's error message on any non-201 response.
 */
export async function sendTwilioSms(params: {
  to: string;
  from: string;
  body: string;
}): Promise<TwilioSendResult> {
  const { accountSid, authToken } = getTwilioCredentials();

  const response = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: params.to,
      From: params.from,
      Body: params.body,
    }),
  });

  const result = (await response.json()) as {
    sid?: string;
    status?: string;
    message?: string;
  };

  if (response.status !== 201) {
    throw new Error(result.message ?? `Twilio request failed with status ${response.status}`);
  }

  return { sid: result.sid ?? "", status: result.status ?? "unknown" };
}

/**
 * Validate an X-Twilio-Signature header for a form-encoded webhook request:
 * base64(HMAC-SHA1(authToken, url + sortedKey1 + value1 + sortedKey2 + value2 ...)).
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  if (!signature) {
    return false;
  }
  const { authToken } = getTwilioCredentials();

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", authToken).update(payload, "utf8").digest();
  const provided = Buffer.from(signature, "base64");

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
