import { redirect } from "next/navigation";

import { MessagesClient } from "@/components/messages/messages-client";
import { getCurrentStaff } from "@/lib/auth";

/**
 * Messages. Two-way SMS chat with customers over the shared Twilio number.
 * History is backfilled from the Twilio API (so Xano-sent texts appear too);
 * new inbound messages arrive via the Twilio webhook + Supabase Realtime.
 */
export default async function MessagesPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/messages");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/dashboard");

  return <MessagesClient />;
}
