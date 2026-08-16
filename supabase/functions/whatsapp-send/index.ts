// Authenticated outbound WhatsApp. The WhatsApp counterpart of sms-send.
//
// Deployed with JWT ON: the caller is the signed-in staff user, and the browser's
// supabase-js attaches their token automatically. Any active staff member may send;
// the send is stamped with their staff id and business.
//
// The caller does not choose template vs free-form. It sends whichever Meta allows:
// free-form while the customer's 24-hour window is open, the approved template
// otherwise. Send both a body and a contentSid and the message goes out either way;
// send only a body and it is refused once the window closes, with that as the reason.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.

import { corsHeaders, json, normalizeUsPhone } from "../_shared/sms.ts";
import { requireStaff } from "../_shared/staff-auth.ts";
import { isWindowOpen, sendWhatsapp, stripWhatsappPrefix } from "../_shared/whatsapp.ts";

interface Payload {
  to?: string;
  body?: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
  bookingId?: string;
  customerId?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const to = normalizeUsPhone(payload.to) ?? stripWhatsappPrefix(payload.to ?? "");
  if (!to) return json({ error: "to is required" }, 400);
  if (!payload.body && !payload.contentSid) {
    return json({ error: "body or contentSid is required" }, 400);
  }

  // Read the window once and hand it to the sender, so a GET-then-send never
  // disagrees with what actually happens.
  const windowOpen = await isWindowOpen(to);

  const result = await sendWhatsapp({
    to,
    body: payload.body ?? null,
    contentSid: payload.contentSid ?? null,
    contentVariables: payload.contentVariables ?? null,
    businessId: auth.staff.business_id,
    bookingId: payload.bookingId ?? null,
    customerId: payload.customerId ?? null,
    sentByStaffId: auth.staff.id,
    windowOpen,
  });

  return json({ ...result, windowOpen }, result.sent ? 200 : 422);
});
