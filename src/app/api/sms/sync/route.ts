import { NextRequest, NextResponse } from "next/server";

import { requireStaff } from "@/lib/auth/require-staff";
import { syncMessagesFromTwilio } from "@/lib/sms/sync";

/** Backfill/refresh sms_messages from the Twilio Messages API. */
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request, ["owner", "business_manager"]);
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const result = await syncMessagesFromTwilio();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
