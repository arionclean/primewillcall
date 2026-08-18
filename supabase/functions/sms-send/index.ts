// Authenticated outbound SMS. Supabase-native replacement for the Vercel route
// src/app/api/sms/send/route.ts (itself a port of Xano POST /api:DgTgH3v8/sms/v1).
//
// Deployed with JWT ON: the caller is the signed-in staff user, and the browser's
// supabase-js attaches their token automatically. Any active staff member may send;
// the send is stamped with their staff id and business.
//
// Twilio credentials are function secrets here, so Vercel never sees them.

import { corsHeaders, json, sendSms } from "../_shared/sms.ts";
import { requireStaff } from "../_shared/staff-auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let payload: { to?: string; body?: string; tag?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!payload.to || !payload.body) {
    return json({ error: "to and body are required" }, 400);
  }

  const result = await sendSms({
    to: payload.to,
    body: payload.body,
    tag: payload.tag ?? null,
    businessId: auth.staff.business_id,
    sentByStaffId: auth.staff.id,
  });
  return json(result, result.sent ? 200 : 422);
});
