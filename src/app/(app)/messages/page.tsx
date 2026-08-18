import { redirect } from "next/navigation";

import { MessagesClient } from "@/components/messages/messages-client";
import { getCurrentStaff } from "@/lib/auth";

/**
 * Messages. Two-way chat with customers over the shared Twilio number, SMS and
 * WhatsApp in one thread: staff talk to a person, not to a channel. The merge
 * happens in the database (messaging_conversations / messaging_thread), so the
 * browser never pulls both tables and stitches them together itself.
 *
 * SMS history is backfilled from the Twilio API (so Xano-sent texts appear too);
 * new inbound messages on either channel arrive via the Twilio webhook plus a
 * Supabase Realtime subscription on both tables.
 */
export default async function MessagesPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/messages");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/dashboard");

  return <MessagesClient />;
}
