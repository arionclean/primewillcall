import { NextRequest, NextResponse } from "next/server";

import { requireStaff } from "@/lib/auth/require-staff";
import { sendSms } from "@/lib/sms/messages";

/**
 * Authenticated outbound-SMS endpoint, port of Xano POST /api:DgTgH3v8/sms/v1.
 * Requires a Supabase access token for an active staff user.
 */
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  let payload: { to?: string; body?: string; tag?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!payload.to || !payload.body) {
    return NextResponse.json({ error: "to and body are required" }, { status: 400 });
  }

  const result = await sendSms({
    to: payload.to,
    body: payload.body,
    tag: payload.tag,
    businessId: auth.businessId,
    sentByStaffId: auth.staffId,
  });
  return NextResponse.json(result, { status: result.sent ? 200 : 422 });
}
