import { NextRequest, NextResponse } from "next/server";

import { requireMerchant } from "@/lib/auth/require-merchant";
import { syncMessagesFromTwilio } from "@/lib/sms/sync";

/** Backfill/refresh sms_messages from the Twilio Messages API. */
export async function POST(request: NextRequest) {
  const auth = await requireMerchant(request);
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
