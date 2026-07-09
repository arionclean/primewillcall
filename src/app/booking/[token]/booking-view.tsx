"use client";

import { useState } from "react";
import { Clock, Info, MapPin, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Client half of the public booking page: three tabs (Ticket, Meeting point,
// Support). Everything shown here is computed server-side in page.tsx and
// passed down as plain strings, so this component only manages tab state.

export type PublicBooking = {
  productName: string;
  businessName: string;
  logoUrl: string | null;
  whenLabel: string;
  departureLabel: string;
  guestName: string;
  totalPax: number;
  paxDetail: string;
  status: "pending" | "confirmed" | "checked_in" | "completed" | "cancelled";
  meetingAddress: string | null;
  mapsUrl: string | null;
  instructions: string | null;
  supportEmail: string | null;
  supportPhoneDisplay: string | null;
  supportPhoneTel: string | null;
};

const TABS = [
  { key: "ticket", label: "Ticket" },
  { key: "meeting", label: "Meeting point" },
  { key: "support", label: "Support" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function BookingView({ booking }: { booking: PublicBooking }) {
  const [tab, setTab] = useState<TabKey>("ticket");

  return (
    <Shell>
      <nav className="mb-5 flex gap-2" aria-label="Booking sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium transition",
              tab === t.key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "ticket" && <TicketPanel booking={booking} />}
      {tab === "meeting" && <MeetingPanel booking={booking} />}
      {tab === "support" && <SupportPanel booking={booking} />}
    </Shell>
  );
}

function TicketPanel({ booking }: { booking: PublicBooking }) {
  return (
    <section>
      <h1 className="mb-3 text-xl font-semibold tracking-tight">
        Your booking
      </h1>
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex items-center gap-3">
            {booking.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={booking.logoUrl}
                alt=""
                className="h-11 w-11 rounded-md border bg-background object-cover"
              />
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted text-sm font-semibold text-muted-foreground">
                {booking.businessName.slice(0, 1) || "?"}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-semibold">{booking.productName}</p>
              {booking.businessName &&
                booking.businessName !== booking.productName && (
                  <p className="truncate text-xs text-muted-foreground">
                    {booking.businessName}
                  </p>
                )}
            </div>
            {booking.status === "cancelled" && (
              <Badge tone="danger" className="ml-auto">
                Cancelled
              </Badge>
            )}
            {booking.status === "pending" && (
              <Badge tone="warning" className="ml-auto">
                Waiting for payment
              </Badge>
            )}
          </div>

          <hr />

          <div className="space-y-2.5 text-sm">
            <p className="flex items-center gap-2.5">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">{booking.whenLabel}</span>
            </p>
            <p className="flex items-center gap-2.5">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">{booking.guestName}</span>
                <span className="text-muted-foreground">
                  {" "}
                  ({booking.totalPax}{" "}
                  {booking.totalPax === 1 ? "guest" : "guests"}
                  {booking.paxDetail ? `: ${booking.paxDetail}` : ""})
                </span>
              </span>
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function MeetingPanel({ booking }: { booking: PublicBooking }) {
  const hasAnything =
    booking.mapsUrl || booking.meetingAddress || booking.instructions;
  return (
    <section>
      <h1 className="mb-3 text-xl font-semibold tracking-tight">
        Where to go?
      </h1>
      <Card>
        <CardContent className="space-y-4 py-5">
          {booking.mapsUrl && (
            <a
              href={booking.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-md bg-foreground px-4 py-2.5 text-center text-sm font-semibold text-background transition hover:opacity-90"
            >
              Open in Maps
            </a>
          )}

          <div className="space-y-3 text-sm">
            {booking.meetingAddress && (
              <p className="flex items-start gap-2.5">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">{booking.meetingAddress}</span>
              </p>
            )}
            <p className="flex items-center gap-2.5">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                Departure time{" "}
                <span className="font-medium">{booking.departureLabel}</span>
              </span>
            </p>
            {booking.instructions && (
              <p className="flex items-start gap-2.5">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="whitespace-pre-line text-muted-foreground">
                  {booking.instructions}
                </span>
              </p>
            )}
            {!hasAnything && (
              <p className="text-muted-foreground">
                Meeting point details will be shared before your tour. Reach out
                from the Support tab if you have questions.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function SupportPanel({ booking }: { booking: PublicBooking }) {
  return (
    <section>
      <h1 className="mb-3 text-xl font-semibold tracking-tight">Support</h1>
      <Card>
        <CardContent className="space-y-3 py-5 text-sm">
          {booking.supportEmail && (
            <p>
              Contact {booking.businessName || "us"} at{" "}
              <a
                href={`mailto:${booking.supportEmail}`}
                className="font-medium underline underline-offset-2"
              >
                {booking.supportEmail}
              </a>
            </p>
          )}
          {booking.supportPhoneDisplay && booking.supportPhoneTel && (
            <p>
              Or call or text{" "}
              <a
                href={`tel:${booking.supportPhoneTel}`}
                className="font-medium underline underline-offset-2"
              >
                {booking.supportPhoneDisplay}
              </a>
            </p>
          )}
          {!booking.supportEmail && !booking.supportPhoneDisplay && (
            <p className="text-muted-foreground">
              Reply to your booking confirmation email and our team will help
              you out.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function BookingNotFound() {
  return (
    <Shell>
      <Card>
        <CardContent className="space-y-2 py-8 text-center">
          <p className="font-semibold">We could not find this booking</p>
          <p className="text-sm text-muted-foreground">
            The link may be incomplete or out of date. Check the link in your
            confirmation message and try again.
          </p>
        </CardContent>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-muted/40 px-4 py-6">
      <div className="mx-auto w-full max-w-md">{children}</div>
    </main>
  );
}
