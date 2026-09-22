import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { InboundView, type InboundEmailRow } from "./inbound-view";

/** How many emails the screen shows. Enough to cover a busy morning. */
const PAGE_SIZE = 50;

/**
 * Email intake. Every OTA reservation email that reached this platform, and what
 * became of it.
 *
 * This is the screen that replaces Make's execution history. It exists because the
 * intake is the one pipeline where a silent failure costs a real person their
 * reservation: a guest books through an OTA, the email does not turn into a booking,
 * and nobody finds out until they are standing at the dock. So the screen answers
 * two questions in the first second, before any list: is email still arriving, and
 * did anything fail.
 */
export default async function InboundEmailsPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/inbound");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role !== "owner") redirect("/dashboard");

  const supabase = await getSupabaseServerClient();

  const [{ data: rows, error }, { data: settings }] = await Promise.all([
    supabase
      .from("inbound_emails")
      .select(
        "id, received_at, from_address, subject, status, attempts, error, booking_id, match_queue_id, provider_email_id, booking:bookings!inbound_emails_booking_id_fkey(starts_at)",
      )
      .order("received_at", { ascending: false })
      .limit(PAGE_SIZE),
    supabase
      .from("inbound_email_settings")
      .select("silence_minutes, alerts_enabled")
      .eq("id", true)
      .maybeSingle(),
  ]);

  if (error) console.error("[inbound] fetch error:", error);

  // The bookings list opens on a day, so a link straight to the guest needs the
  // departure date as well as the id.
  type Joined = Omit<InboundEmailRow, "booking_starts_at"> & {
    booking: { starts_at: string | null } | null;
  };
  const list = ((rows ?? []) as unknown as Joined[]).map<InboundEmailRow>((r) => ({
    id: r.id,
    received_at: r.received_at,
    from_address: r.from_address,
    subject: r.subject,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    booking_id: r.booking_id,
    booking_starts_at: r.booking?.starts_at ?? null,
    match_queue_id: r.match_queue_id,
    provider_email_id: r.provider_email_id,
  }));

  // Counted over the visible window rather than a second round trip: the screen
  // shows the recent past, and that is exactly the span these numbers describe.
  const failed = list.filter((r) => r.status === "failed").length;
  const waiting = list.filter((r) => r.status === "received").length;
  const booked = list.filter((r) => r.status === "booked").length;

  return (
    <InboundView
      rows={list}
      failed={failed}
      waiting={waiting}
      booked={booked}
      silenceMinutes={settings?.silence_minutes ?? 180}
      alertsEnabled={settings?.alerts_enabled ?? true}
    />
  );
}
