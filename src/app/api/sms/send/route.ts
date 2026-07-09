import { NextResponse } from "next/server";

import { getCurrentStaff } from "@/lib/auth";
import { sendSms } from "@/lib/sms/messages";

/**
 * Authenticated outbound-SMS endpoint, port of Xano POST /api:DgTgH3v8/sms/v1.
 * Cookie-session auth: any active staff user can send; the send is stamped
 * with their staff id and business.
 */
export async function POST(request: Request) {
  const { user, staff } = await getCurrentStaff();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!staff || !staff.is_active) {
    return NextResponse.json({ error: "Active staff account required" }, { status: 403 });
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
    businessId: staff.business_id,
    sentByStaffId: staff.id,
  });
  return NextResponse.json(result, { status: result.sent ? 200 : 422 });
}
