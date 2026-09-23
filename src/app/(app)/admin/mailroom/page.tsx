import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import {
  MailroomView,
  type MailroomRow,
  type MailroomStep,
  type MailroomText,
} from "./mailroom-view";

/** How many emails the screen shows. Enough to cover a busy morning. */
const PAGE_SIZE = 50;

/**
 * The Mailroom. Every OTA reservation email that reached this platform, what each
 * step did with it, and what became of it.
 *
 * An internal tool, on purpose: owner only, and linked from nowhere in the app. The
 * way in is the link in a Mailroom alert (text or email), which opens the email that
 * needs a look (`?email=<id>`). It exists because the intake is the one pipeline where
 * a silent failure costs a real person their reservation, so it answers two questions
 * in the first second, before any list: is email still arriving, and did anything fail.
 */
export default async function MailroomPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; email?: string }>;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/mailroom");
  if (!staff || !staff.is_active || staff.role !== "owner") redirect("/dashboard");

  const { show, email } = await searchParams;
  const attentionOnly = show === "attention";

  const supabase = await getSupabaseServerClient();

  let list = supabase
    .from("inbound_emails")
    .select(
      "id, received_at, from_address, subject, status, attempts, error, booking_id, " +
        "match_queue_id, legacy_company_id, steps, warnings, alert_sent_at, ignored_at, " +
        "last_attempt_at, provider_email_id, " +
        "booking:bookings!inbound_emails_booking_id_fkey(starts_at, inbound_email_id)",
    )
    .order("received_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (attentionOnly) {
    // Failed, still being worked on, or booked with a detail missing.
    list = list.or("status.eq.failed,status.eq.received,warnings.neq.{}");
  }

  const [{ data: rows, error }, { data: summary }, { data: settings }, { data: businesses }] =
    await Promise.all([
      list,
      supabase.rpc("mailroom_summary").maybeSingle(),
      supabase
        .from("inbound_email_settings")
        .select("silence_minutes, alerts_enabled")
        .eq("id", true)
        .maybeSingle(),
      supabase.from("businesses").select("name, legacy_company_id"),
    ]);
  if (error) console.error("[mailroom] fetch error:", error);

  type Joined = {
    id: string;
    received_at: string;
    from_address: string | null;
    subject: string | null;
    status: string;
    attempts: number;
    error: string | null;
    booking_id: string | null;
    match_queue_id: string | null;
    legacy_company_id: string | null;
    steps: unknown;
    warnings: string[];
    alert_sent_at: string | null;
    ignored_at: string | null;
    last_attempt_at: string | null;
    provider_email_id: string;
    booking: { starts_at: string | null; inbound_email_id: string | null } | null;
  };
  const joined = (rows ?? []) as unknown as Joined[];

  // Did the guest get their text? One read for the whole page, confirmation and
  // opt-in messages only (the review funnel comes after the tour).
  const bookingIds = joined.flatMap((r) => (r.booking_id ? [r.booking_id] : []));
  const textsByBooking = new Map<string, MailroomText>();
  if (bookingIds.length > 0) {
    const { data: texts } = await supabase
      .from("scheduled_messages")
      .select("booking_id, status, sent_at, send_at, tag")
      .in("booking_id", bookingIds)
      .in("tag", ["bookingConfirmation", "optIn"])
      .order("send_at", { ascending: true });
    for (const t of texts ?? []) {
      if (!t.booking_id) continue;
      const prev = textsByBooking.get(t.booking_id);
      // A failure anywhere is the thing worth showing; otherwise the latest state.
      if (prev?.status === "failed") continue;
      textsByBooking.set(t.booking_id, {
        status: t.status,
        at: t.sent_at ?? t.send_at,
      });
    }
  }

  const businessByCompany = new Map(
    (businesses ?? []).flatMap((b) =>
      b.legacy_company_id ? [[b.legacy_company_id, b.name] as const] : []
    ),
  );

  const view: MailroomRow[] = joined.map((r) => ({
    id: r.id,
    received_at: r.received_at,
    from_address: r.from_address,
    subject: r.subject,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    booking_id: r.booking_id,
    booking_starts_at: r.booking?.starts_at ?? null,
    created_here: Boolean(r.booking?.inbound_email_id && r.booking.inbound_email_id === r.id),
    match_queue_id: r.match_queue_id,
    business: r.legacy_company_id ? businessByCompany.get(r.legacy_company_id) ?? null : null,
    steps: Array.isArray(r.steps) ? (r.steps as MailroomStep[]) : [],
    warnings: r.warnings ?? [],
    alert_sent_at: r.alert_sent_at,
    ignored_at: r.ignored_at,
    last_attempt_at: r.last_attempt_at,
    provider_email_id: r.provider_email_id,
    text: r.booking_id ? textsByBooking.get(r.booking_id) ?? null : null,
  }));

  return (
    <MailroomView
      rows={view}
      attentionOnly={attentionOnly}
      openId={email ?? null}
      summary={{
        lastReceivedAt: summary?.last_received_at ?? null,
        failed: Number(summary?.failed ?? 0),
        working: Number(summary?.working ?? 0),
        bookedToday: Number(summary?.booked_today ?? 0),
        warningsWeek: Number(summary?.warnings_week ?? 0),
      }}
      silenceMinutes={settings?.silence_minutes ?? 180}
      alertsEnabled={settings?.alerts_enabled ?? true}
    />
  );
}
