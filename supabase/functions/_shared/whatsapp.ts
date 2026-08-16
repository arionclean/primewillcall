/**
 * Shared WhatsApp primitives for the edge functions (whatsapp-send,
 * twilio-inbound-sms, dispatch-scheduled-messages).
 *
 * WhatsApp has one rule SMS does not: you may only start a conversation with a
 * template Meta approved. When the customer replies, a 24-hour service window
 * opens and free-form messages are allowed until it closes (each new reply
 * restarts it). So every send here goes through pickWhatsappMode(), which reads
 * the window and decides template vs free-form rather than letting a caller
 * guess and collect a Twilio 63016.
 *
 * Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.
 */

import { ACCOUNT_SID, AUTH_TOKEN, db, findCustomerByPhone, TWILIO_HOST, twilioAuthHeader } from "./sms.ts";

const WHATSAPP_FROM_RAW = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "";

/** The configured sender in E.164, without the `whatsapp:` channel prefix. */
export function whatsappFrom(): string {
  const raw = WHATSAPP_FROM_RAW.trim().replace(/^whatsapp:/i, "");
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${raw}`;
}

/** Twilio addresses WhatsApp as `whatsapp:+1...`; our tables store the bare number. */
export function stripWhatsappPrefix(value: string): string {
  return value.replace(/^whatsapp:/i, "").trim();
}

export function isWhatsappAddress(value: string | null | undefined): boolean {
  return /^whatsapp:/i.test((value ?? "").trim());
}

/* ----------------------------------------------------------- 24h window */

/**
 * Is the 24-hour service window open for this number?
 *
 * Delegates to the whatsapp_window_open() SQL function so the app and the
 * database never disagree about what "open" means.
 */
export async function isWindowOpen(phone: string): Promise<boolean> {
  const { data, error } = await db.rpc("whatsapp_window_open", { p_phone: phone });
  if (error) {
    // Fail closed: if we cannot prove the window is open, use a template.
    console.error("WhatsApp window check failed:", error.message);
    return false;
  }
  return data === true;
}

/* -------------------------------------------------------------- logging */

export interface WhatsappLogEntry {
  direction: "inbound" | "outbound";
  from_phone: string;
  to_phone: string;
  body: string;
  status?: string | null;
  twilio_sid?: string | null;
  error?: string | null;
  business_id?: string | null;
  customer_id?: string | null;
  booking_id?: string | null;
  sent_by_staff_id?: string | null;
}

/** Record a WhatsApp message, linking it to a customer by phone like the SMS log does. */
export async function logWhatsappMessage(entry: WhatsappLogEntry): Promise<void> {
  let row = entry;
  if (!row.customer_id) {
    const counterpart = row.direction === "inbound" ? row.from_phone : row.to_phone;
    const customer = await findCustomerByPhone(counterpart);
    if (customer) {
      row = { ...row, customer_id: customer.id, business_id: row.business_id ?? customer.business_id };
    }
  }
  const { error } = await db.from("whatsapp_messages").insert(row);
  // Logging must never break the send/receive path.
  if (error) console.error("Failed to log WhatsApp message:", error.message);
}

/* ----------------------------------------------------------------- send */

export interface SendWhatsappResult {
  sent: boolean;
  status: string;
  sid?: string;
  reason?: string;
  /** Which form the message actually took, so the caller can tell the user. */
  mode?: "freeform" | "template";
}

/** Human-readable record of a template send, since the body lives in Twilio. */
function templateSummary(contentSid: string, vars: Record<string, string>): string {
  return `[template ${contentSid}] ${JSON.stringify(vars)}`;
}

async function postToTwilio(
  params: URLSearchParams,
): Promise<{ ok: boolean; sid?: string; status?: string; error?: string }> {
  if (!ACCOUNT_SID || !AUTH_TOKEN) return { ok: false, error: "Twilio credentials not configured" };
  try {
    const response = await fetch(`${TWILIO_HOST}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const json = await response.json() as { sid?: string; status?: string; message?: string };
    if (response.status === 201 && json.sid) {
      return { ok: true, sid: json.sid, status: json.status ?? "queued" };
    }
    return { ok: false, error: json.message ?? `Twilio HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface SendWhatsappInput {
  to: string;
  /** Free-form text. Only sendable while the 24h window is open. */
  body?: string | null;
  /** Approved Twilio Content template. Required to open a conversation. */
  contentSid?: string | null;
  contentVariables?: Record<string, string> | null;
  businessId?: string | null;
  bookingId?: string | null;
  customerId?: string | null;
  sentByStaffId?: string | null;
  /** Skip the window lookup when the caller already did it. */
  windowOpen?: boolean;
}

/**
 * Send one WhatsApp message and record it.
 *
 * Picks the form Meta allows: free-form when the customer wrote to us in the
 * last 24 hours and a body was supplied, the approved template otherwise. A
 * free-form-only request outside the window is refused here rather than sent
 * and rejected by Twilio, so the reason we surface is the real one.
 */
export async function sendWhatsapp(input: SendWhatsappInput): Promise<SendWhatsappResult> {
  const from = whatsappFrom();
  if (!from) return { sent: false, status: "failed", reason: "TWILIO_WHATSAPP_FROM not configured" };

  const to = stripWhatsappPrefix(input.to);
  if (!to) return { sent: false, status: "failed", reason: "No recipient number" };

  const body = (input.body ?? "").trim();
  const contentSid = (input.contentSid ?? "").trim();
  const windowOpen = input.windowOpen ?? (body ? await isWindowOpen(to) : false);

  const useFreeform = body.length > 0 && windowOpen;
  if (!useFreeform && !contentSid) {
    return {
      sent: false,
      status: "skipped",
      reason: body
        ? "The 24-hour WhatsApp window is closed, so this needs an approved template"
        : "No WhatsApp template selected",
    };
  }

  const params = new URLSearchParams({ To: `whatsapp:${to}`, From: `whatsapp:${from}` });
  const contentVariables = input.contentVariables ?? {};
  if (useFreeform) {
    params.set("Body", body);
  } else {
    params.set("ContentSid", contentSid);
    if (Object.keys(contentVariables).length > 0) {
      params.set("ContentVariables", JSON.stringify(contentVariables));
    }
  }

  const result = await postToTwilio(params);
  const mode = useFreeform ? "freeform" : "template";

  await logWhatsappMessage({
    direction: "outbound",
    from_phone: from,
    to_phone: to,
    body: useFreeform ? body : templateSummary(contentSid, contentVariables),
    status: result.ok ? result.status ?? "queued" : "failed",
    twilio_sid: result.sid ?? null,
    error: result.error ?? null,
    business_id: input.businessId ?? null,
    booking_id: input.bookingId ?? null,
    customer_id: input.customerId ?? null,
    sent_by_staff_id: input.sentByStaffId ?? null,
  });

  if (!result.ok) return { sent: false, status: "failed", reason: result.error, mode };
  return { sent: true, status: result.status ?? "queued", sid: result.sid, mode };
}
