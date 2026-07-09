import { NextResponse } from "next/server";

import { getCurrentStaff } from "@/lib/auth";
import { syncMessagesFromTwilio } from "@/lib/sms/sync";

/** Backfill/refresh sms_messages from the Twilio Messages API. */
export async function POST() {
  const { user, staff } = await getCurrentStaff();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (
    !staff ||
    !staff.is_active ||
    (staff.role !== "owner" && staff.role !== "business_manager")
  ) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  try {
    const result = await syncMessagesFromTwilio();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
