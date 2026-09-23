"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Mail,
  Minus,
  RotateCw,
  X,
  Check,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";
import { formatUsPhoneDisplay } from "@/lib/sms/format";
import { cn } from "@/lib/utils";

import {
  loadEmailText,
  retryEmail,
  setAsideEmail,
  type MailroomActionState,
} from "./actions";

const BUSINESS_TZ = "America/New_York";

/** One step of a pass, as runPass records it in inbound_emails.steps. */
export type MailroomStep = {
  step: "fetch" | "read" | "book";
  ok: boolean;
  at: string;
  ms: number;
  note: string;
  data?: Record<string, unknown>;
};

/** The guest's confirmation text, from scheduled_messages. */
export type MailroomText = { status: string; at: string | null };

export type MailroomRow = {
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
  /** This email created the booking (so its texts are ours to send). */
  created_here: boolean;
  match_queue_id: string | null;
  business: string | null;
  steps: MailroomStep[];
  warnings: string[];
  alert_sent_at: string | null;
  ignored_at: string | null;
  last_attempt_at: string | null;
  provider_email_id: string;
  text: MailroomText | null;
};

/** Plain-language status. Nobody reads 'parsed' or an enum value. */
const STATUS: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }
> = {
  booked: { label: "Booked", tone: "success" },
  received: { label: "Working on it", tone: "info" },
  parsed: { label: "Not a booking", tone: "neutral" },
  failed: { label: "Needs a look", tone: "danger" },
  ignored: { label: "Set aside", tone: "neutral" },
};

/** The words for the warning codes runPass records. */
const WARNING_TEXT: Record<string, string> = {
  no_guest_count: "No guest count",
  guest_count_mismatch: "The guest count does not match the email's total",
  no_guest_name: 'No guest name (booked as "Guest")',
  no_channel: "No sales channel",
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

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
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

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The reader keeps digits only: a US number reads as (XXX) XXX-XXXX, others as +digits. */
function phoneDisplay(digits: string): string {
  const us = formatUsPhoneDisplay(digits);
  return us === digits ? `+${digits}` : us;
}

/** The New York calendar day of a UTC instant, as the bookings list expects it. */
function nyDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function MailroomView({
  rows,
  attentionOnly,
  openId,
  summary,
  silenceMinutes,
  alertsEnabled,
}: {
  rows: MailroomRow[];
  attentionOnly: boolean;
  openId: string | null;
  summary: {
    lastReceivedAt: string | null;
    failed: number;
    working: number;
    bookedToday: number;
    warningsWeek: number;
  };
  silenceMinutes: number;
  alertsEnabled: boolean;
}) {
  // An email that lands while this screen is open appears on it, and a Retry's
  // result arrives the same way. Subscribe for the signal, let the server fetch.
  useLiveRefresh("admin-mailroom", [{ table: "inbound_emails" }]);

  const last = summary.lastReceivedAt;
  const quietMinutes = last ? Math.round((Date.now() - new Date(last).getTime()) / 60_000) : null;
  const silent = quietMinutes !== null && quietMinutes >= silenceMinutes;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Mailroom</h1>
        <p className="text-sm text-muted-foreground">
          Every booking email that reached us, what each step did with it, and what
          became of it.
        </p>
      </header>

      {/* The health line. Two questions, answered before the list. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className={cn("px-5 py-4", silent && "border-red-300 dark:border-red-900")}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Mail className="size-4" />
            Last email
          </div>
          <p className="mt-1 text-lg font-semibold">{last ? fmtAgo(last) : "none yet"}</p>
          {silent ? (
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              Nothing has arrived in {Math.floor((quietMinutes ?? 0) / 60)}h. Check the
              mailbox forwarding, the MX record and the Resend webhook.
            </p>
          ) : null}
        </Card>

        <Card
          className={cn("px-5 py-4", summary.failed > 0 && "border-red-300 dark:border-red-900")}
        >
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="size-4" />
            Needs a look
          </div>
          <p className="mt-1 text-lg font-semibold">{summary.failed}</p>
          <p
            className={cn(
              "mt-1 text-sm",
              summary.failed > 0 ? "text-red-700 dark:text-red-300" : "text-muted-foreground",
            )}
          >
            {summary.failed > 0
              ? "These guests may not be on the manifest."
              : summary.working > 0
                ? `${summary.working} still being worked on.`
                : "Nothing failed."}
          </p>
        </Card>

        <Card className="px-5 py-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" />
            Booked today
          </div>
          <p className="mt-1 text-lg font-semibold">{summary.bookedToday}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.warningsWeek > 0
              ? `${summary.warningsWeek} this week came with a detail missing.`
              : "All complete this week."}
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

      <nav className="flex gap-1 text-sm" aria-label="Filter">
        <FilterLink href="/admin/mailroom" active={!attentionOnly}>
          All emails
        </FilterLink>
        <FilterLink href="/admin/mailroom?show=attention" active={attentionOnly}>
          Needs a look
        </FilterLink>
      </nav>

      <Card className="divide-y">
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {attentionOnly
              ? "Nothing needs a look."
              : "No booking emails yet. They appear here the moment one arrives."}
          </p>
        ) : (
          rows.map((row) => (
            <EmailRow key={row.id} row={row} startOpen={row.id === openId} />
          ))
        )}
      </Card>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-lg px-3 py-1.5 transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function EmailRow({ row, startOpen }: { row: MailroomRow; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const ref = useRef<HTMLDivElement>(null);
  const meta = STATUS[row.status] ?? { label: row.status, tone: "neutral" as const };

  // Arriving from an alert's link: bring that email into view.
  useEffect(() => {
    if (startOpen) ref.current?.scrollIntoView({ block: "center" });
  }, [startOpen]);

  return (
    <div ref={ref} className={cn(open && "bg-muted/30")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-col gap-2 px-5 py-4 text-left sm:flex-row sm:items-start"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium">{row.subject ?? "(no subject)"}</p>
          <p className="truncate text-sm text-muted-foreground">
            {row.from_address ?? "unknown sender"}
            {row.business ? ` · ${row.business}` : ""}
          </p>
          {row.error ? (
            <p className="text-sm text-red-700 dark:text-red-300">{row.error}</p>
          ) : null}
          {row.warnings.length > 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {row.warnings.map((w) => WARNING_TEXT[w] ?? w).join(" · ")}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {row.match_queue_id ? <Badge tone="warning">Needs a tour</Badge> : null}
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" />
            {fmtWhen(row.received_at)}
          </span>
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </button>

      {open ? <EmailDetail row={row} /> : null}
    </div>
  );
}

type NodeState = "ok" | "failed" | "waiting" | "skipped";

const NODE_ICON: Record<NodeState, LucideIcon> = {
  ok: Check,
  failed: X,
  waiting: Clock,
  skipped: Minus,
};

const NODE_STYLE: Record<NodeState, string> = {
  ok: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  failed:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  waiting:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  skipped: "border-border bg-muted text-muted-foreground",
};

type FlowNode = { label: string; state: NodeState; note: string; ms?: number };

/**
 * The email's journey as five stops, Make's module bubbles in one line: it arrived,
 * we fetched it, we read it, we booked it, the guest was texted. Built from the
 * steps runPass recorded plus the guest's confirmation text.
 */
function flowFor(row: MailroomRow): FlowNode[] {
  const byStep = new Map(row.steps.map((s) => [s.step, s]));
  const working = row.status === "received";
  const fromStep = (key: MailroomStep["step"], label: string): FlowNode => {
    const s = byStep.get(key);
    if (s) return { label, state: s.ok ? "ok" : "failed", note: s.note, ms: s.ms };
    // An earlier step failed, or the pass is still running.
    const failedBefore = row.steps.some((x) => !x.ok);
    return {
      label,
      state: failedBefore ? "skipped" : working ? "waiting" : "skipped",
      note: failedBefore ? "Not reached" : working ? "Waiting" : "",
    };
  };

  const nodes: FlowNode[] = [
    { label: "Arrived", state: "ok", note: fmtWhen(row.received_at) },
  ];

  if (row.steps.length === 0 && !working) {
    // Processed before steps were recorded (2026-09-23): only the ending is known.
    const booked = row.status === "booked";
    nodes.push(
      { label: "Fetched", state: "ok", note: "Not recorded" },
      { label: "Read", state: row.status === "failed" ? "failed" : "ok", note: "Not recorded" },
      {
        label: "Booked",
        state: booked ? "ok" : "skipped",
        note: booked ? "Not recorded" : row.status === "parsed" ? "Not a booking" : "",
      },
    );
  } else {
    nodes.push(fromStep("fetch", "Fetched"), fromStep("read", "Read"));
    if (row.status === "parsed" || (row.status === "ignored" && !byStep.has("book"))) {
      nodes.push({ label: "Booked", state: "skipped", note: "Not a booking" });
    } else {
      nodes.push(fromStep("book", "Booked"));
    }
  }

  // The guest's text. Only a booking this email created is ours to text; older ones
  // (before the Mailroom took over texting, 2026-09-23) were texted by Xano.
  const t = row.text;
  if (!row.booking_id) {
    nodes.push({
      label: "Texted",
      state: "skipped",
      note: row.steps.some((x) => !x.ok) ? "Not reached" : "",
    });
  } else if (t?.status === "sent") {
    nodes.push({ label: "Texted", state: "ok", note: t.at ? fmtTime(t.at) : "Sent" });
  } else if (t?.status === "failed") {
    nodes.push({ label: "Texted", state: "failed", note: "The text failed" });
  } else if (t) {
    nodes.push({ label: "Texted", state: "waiting", note: "Queued" });
  } else if (row.created_here) {
    nodes.push({ label: "Texted", state: "skipped", note: "No text (no phone or no rule)" });
  } else {
    nodes.push({ label: "Texted", state: "skipped", note: "Not texted from here" });
  }
  return nodes;
}

function EmailDetail({ row }: { row: MailroomRow }) {
  const nodes = flowFor(row);
  const read = row.steps.find((s) => s.step === "read")?.data ?? null;
  const canRetry = ["failed", "parsed", "ignored", "received"].includes(row.status);
  const canSetAside = ["failed", "parsed", "received"].includes(row.status);

  return (
    <div className="space-y-5 px-5 pb-5">
      <ol className="grid gap-2 sm:grid-cols-5">
        {nodes.map((n) => {
          const Icon = NODE_ICON[n.state];
          return (
            <li key={n.label} className={cn("rounded-lg border px-3 py-2", NODE_STYLE[n.state])}>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Icon className="size-3.5" />
                {n.label}
                {n.ms != null ? (
                  <span className="ml-auto text-xs font-normal opacity-70">{fmtMs(n.ms)}</span>
                ) : null}
              </div>
              {n.note ? <p className="mt-1 text-xs leading-snug">{n.note}</p> : null}
            </li>
          );
        })}
      </ol>

      {read ? <ReadDetails data={read} business={row.business} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {row.booking_id ? (
          <Link
            href={
              row.booking_starts_at
                ? `/bookings?date=${nyDay(row.booking_starts_at)}&booking=${row.booking_id}`
                : `/bookings?booking=${row.booking_id}`
            }
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Open booking
          </Link>
        ) : null}
        {row.match_queue_id ? (
          <Link
            href="/admin/unmatched"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Choose the tour
          </Link>
        ) : null}
        {canRetry ? <ActionButton id={row.id} kind="retry" /> : null}
        {canSetAside ? <ActionButton id={row.id} kind="setAside" /> : null}
      </div>

      <OriginalEmail id={row.id} />

      <p className="text-xs text-muted-foreground">
        {row.attempts} {row.attempts === 1 ? "try" : "tries"}
        {row.last_attempt_at ? ` · last ${fmtWhen(row.last_attempt_at)}` : ""}
        {row.alert_sent_at ? ` · alert sent ${fmtWhen(row.alert_sent_at)}` : ""}
        {row.ignored_at ? ` · set aside ${fmtWhen(row.ignored_at)}` : ""}
        {` · Resend ${row.provider_email_id}`}
      </p>
    </div>
  );
}

/** What the read step extracted, in the words a manifest uses. */
function ReadDetails({
  data,
  business,
}: {
  data: Record<string, unknown>;
  business: string | null;
}) {
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const guests = [
    n(data.adults) ? `${n(data.adults)} adult${n(data.adults) === 1 ? "" : "s"}` : null,
    n(data.children) ? `${n(data.children)} child${n(data.children) === 1 ? "" : "ren"}` : null,
    n(data.infants) ? `${n(data.infants)} infant${n(data.infants) === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const phone = str(data.phone);
  const tour = str(data.tour);

  const items: [string, string | null][] = [
    ["Reference", str(data.reference)],
    ["Departure", str(data.date)],
    ["Guest", str(data.guest)],
    ["Guests", guests.length > 0 ? guests.join(", ") : null],
    ["Phone", phone ? phoneDisplay(phone) : null],
    ["Email", str(data.email)],
    ["Sold through", str(data.channel)],
    ["Product in the email", str(data.product)],
    ["Tour", tour ? `${tour}${data.matched_by === "ai" ? " (matched by AI)" : ""}` : null],
    ["Business", business],
    ["Status in the email", str(data.status)],
  ];

  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className={cn("truncate", !value && "text-muted-foreground")}>
            {value ?? "Not found"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ActionButton({ id, kind }: { id: string; kind: "retry" | "setAside" }) {
  const [state, action] = useActionState<MailroomActionState, FormData>(
    kind === "retry" ? retryEmail : setAsideEmail,
    {},
  );
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant={kind === "retry" ? "default" : "outline"} size="sm">
        {kind === "retry" ? (
          <>
            <RotateCw /> Retry
          </>
        ) : (
          "Set aside"
        )}
      </SubmitButton>
      {state.error ? (
        <span className="text-xs text-red-700 dark:text-red-300">{state.error}</span>
      ) : null}
    </form>
  );
}

/** The email as the reader saw it, fetched only when someone asks for it. */
function OriginalEmail({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!shown) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setText(await loadEmailText(id));
            setShown(true);
          })
        }
      >
        {pending ? "Loading the email..." : "Show the email"}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <Button variant="ghost" size="sm" onClick={() => setShown(false)}>
        Hide the email
      </Button>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background p-4 text-xs leading-relaxed">
        {text ?? "The text of this email was not kept."}
      </pre>
    </div>
  );
}
