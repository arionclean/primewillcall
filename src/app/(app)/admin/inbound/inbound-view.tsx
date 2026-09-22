"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Mail } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";

const BUSINESS_TZ = "America/New_York";

export type InboundEmailRow = {
  id: string;
  received_at: string;
  from_address: string | null;
  subject: string | null;
  status: string;
  attempts: number;
  error: string | null;
  booking_id: string | null;
  /** The departure, so the link can open the bookings list on the right day. */
  booking_starts_at: string | null;
  match_queue_id: string | null;
  provider_email_id: string;
};

/** The New York calendar day of a UTC instant, as the bookings list expects it. */
function nyDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Plain-language status. Staff never read 'parsed' or an enum value. */
const STATUS: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }
> = {
  booked: { label: "Booked", tone: "success" },
  received: { label: "Working on it", tone: "info" },
  parsed: { label: "Not a booking", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  ignored: { label: "Set aside", tone: "neutral" },
};

function fmtWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "4 minutes ago", for the one number that says whether the intake is alive. */
function fmtAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function InboundView({
  rows,
  failed,
  waiting,
  booked,
  silenceMinutes,
  alertsEnabled,
}: {
  rows: InboundEmailRow[];
  failed: number;
  waiting: number;
  booked: number;
  silenceMinutes: number;
  alertsEnabled: boolean;
}) {
  // An email that lands while this screen is open should appear on it. Same
  // pattern as the other watched screens: subscribe for the signal, let the
  // server component fetch the answer.
  useLiveRefresh("admin-inbound", [{ table: "inbound_emails" }]);

  const newest = rows[0]?.received_at ?? null;
  const quietMinutes = newest
    ? Math.round((Date.now() - new Date(newest).getTime()) / 60_000)
    : null;
  const silent = quietMinutes !== null && quietMinutes >= silenceMinutes;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Email intake</h1>
        <p className="text-sm text-muted-foreground">
          Every booking email that reached us, and what became of it.
        </p>
      </header>

      {/* The health line. Two questions, answered before the list. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card
          className={`px-5 py-4 ${silent ? "border-red-300 dark:border-red-900" : ""}`}
        >
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Mail className="size-4" />
            Last email
          </div>
          <p className="mt-1 text-lg font-semibold">
            {newest ? fmtAgo(newest) : "none yet"}
          </p>
          {silent ? (
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              Nothing has arrived in {Math.floor((quietMinutes ?? 0) / 60)}h. Check the
              mailbox forwarding, the MX record and the Resend webhook.
            </p>
          ) : null}
        </Card>

        <Card className={`px-5 py-4 ${failed > 0 ? "border-red-300 dark:border-red-900" : ""}`}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="size-4" />
            Failed
          </div>
          <p className="mt-1 text-lg font-semibold">{failed}</p>
          {failed > 0 ? (
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              These guests may not be on the manifest.
            </p>
          ) : null}
        </Card>

        <Card className="px-5 py-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" />
            Booked
          </div>
          <p className="mt-1 text-lg font-semibold">{booked}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {waiting > 0 ? `${waiting} still being worked on.` : "All caught up."}
          </p>
        </Card>
      </div>

      {!alertsEnabled ? (
        <Card className="border-amber-300 px-5 py-4 text-sm dark:border-amber-900">
          Alerts are switched off, so nobody is told when an email fails or when the
          intake goes quiet. Turn them back on in{" "}
          <code className="text-xs">inbound_email_settings.alerts_enabled</code>.
        </Card>
      ) : null}

      <Card className="divide-y">
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No booking emails yet. They appear here the moment one arrives.
          </p>
        ) : (
          rows.map((row) => {
            const meta = STATUS[row.status] ?? { label: row.status, tone: "neutral" as const };
            return (
              <div key={row.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate font-medium">{row.subject ?? "(no subject)"}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {row.from_address ?? "unknown sender"}
                  </p>
                  {row.error ? (
                    <p className="text-sm text-red-700 dark:text-red-300">
                      {row.error}
                      {row.attempts > 1 ? ` (${row.attempts} tries)` : ""}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  {row.match_queue_id ? (
                    <Link
                      href="/admin/unmatched"
                      className="text-sm text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
                    >
                      Needs a tour
                    </Link>
                  ) : null}
                  {row.booking_id ? (
                    <Link
                      href={
                        row.booking_starts_at
                          ? `/bookings?date=${nyDay(row.booking_starts_at)}&booking=${row.booking_id}`
                          : `/bookings?booking=${row.booking_id}`
                      }
                      className="text-sm text-primary underline-offset-2 hover:underline"
                    >
                      Open booking
                    </Link>
                  ) : null}
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {fmtWhen(row.received_at)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
