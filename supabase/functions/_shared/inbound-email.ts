// The Mailroom: turning one inbound OTA email into a booking.
//
// Shared by the two halves of the intake so they can never drift: email-inbound
// (the Resend webhook, first pass) and email-inbound-sweep (the cron, every later
// pass). Both call runPass() on an inbound_emails row, so both get the same steps in
// the same order and write the row the same way.
//
// The chain is the one the Make scenario ran, moved server-side:
//
//   Resend  ->  GET /emails/receiving/{id}   (the body; the webhook is metadata only)
//           ->  email-booking-parse          (regex + AI product match, no writes)
//           ->  xano-booking-sync            (upsert the booking, keyed on the OTA ref)
//
// Every step is safe to repeat. The parse writes nothing that matters twice, and the
// sync upserts on the booking key, so a retry updates the one booking instead of
// making a second. That is what lets the sweep be dumb about retrying.
//
// Make's strength was showing what each step did. So a pass records its steps as it
// goes (inbound_emails.steps): what the fetch found, what the read extracted, what the
// sync answered, how long each took, and which one broke. That record is what the
// Mailroom screen draws, and it survives a failure, which is when it matters.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Reading an inbound email's body needs a full-access Resend key, which is more
// than every sending path should carry. Keep that key to this one call:
// RESEND_INBOUND_API_KEY when it exists, the shared sending key otherwise.
const RESEND_API_KEY = Deno.env.get("RESEND_INBOUND_API_KEY") ??
  Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_PARSE_SECRET = Deno.env.get("EMAIL_PARSE_SECRET") ?? "";
const XANO_WEBHOOK_SECRET = Deno.env.get("XANO_WEBHOOK_SECRET") ?? "";

/** Long enough for the AI product match on a cold start, short enough to retry. */
const STEP_TIMEOUT_MS = 30_000;

// Which business an email belongs to, by who it was addressed to. Ported verbatim
// from the Make scenario, which tested the recipients for the Key West reservations
// address and fell back to Miami. These are Bubble company ids, matched against
// businesses.legacy_company_id downstream. A third business means a third line here.
const KEY_WEST_INBOX = "reservations@keywestsightseeingtours.com";
const COMPANY_KEY_WEST = "1712896100693x988159247184035800";
const COMPANY_MIAMI = "1712894857551x926333421634977800";

export type InboundRow = {
  id: string;
  provider_email_id: string;
  subject: string | null;
  raw_text: string | null;
  to_addresses: string[] | null;
  legacy_company_id: string | null;
};

/**
 * One step of a pass, as the Mailroom screen shows it. `note` is the line a person
 * reads; `data` is what the step read or answered, for when that line is not enough.
 */
export type Step = {
  step: "fetch" | "read" | "book";
  ok: boolean;
  /** When the step started (ISO) and how long it took. */
  at: string;
  ms: number;
  note: string;
  data?: Record<string, unknown>;
};

export type ProcessOutcome = {
  /** Where the row lands. 'received' never comes back from here. */
  status: "parsed" | "booked";
  raw_text: string;
  legacy_company_id: string;
  booking_id: string | null;
  business_tour_id: string | null;
  match_queue_id: string | null;
  /** The booking key the sync used, handy in the log when no booking row resolved. */
  legacy_id: string | null;
  /** The addresses the business decision was made from. Recorded so it can be
   *  checked against what Make decided, instead of taken on trust. */
  recipients: string[];
  steps: Step[];
  /** Details the read could not find on a booking it still made. Alerted once. */
  warnings: string[];
};

/**
 * A pass that stopped. Carries the steps that ran and whatever the pass had already
 * learned (the body, the recipients, the business), so the row keeps them and the
 * next pass does not ask Resend again. `permanent` means another try cannot help:
 * the row goes straight to 'failed' and a person is told.
 */
export class PassError extends Error {
  constructor(
    message: string,
    readonly steps: Step[],
    readonly learned: {
      raw_text?: string;
      recipients?: string[];
      legacy_company_id?: string;
    } = {},
    readonly permanent = false,
  ) {
    super(message);
  }
}

/** fetch with a deadline: a hung dependency must fail the pass, not hold the cron. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STEP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type ReceivedEmail = {
  text: string;
  subject: string | null;
  from: string | null;
  recipients: string[];
};

/**
 * The email itself. Resend's `email.received` webhook carries metadata only, so the
 * body is a second call, which is also why a retry costs nothing: Resend keeps the
 * email whether or not our webhook ever succeeded.
 */
export async function fetchReceivedEmail(
  providerEmailId: string,
): Promise<ReceivedEmail> {
  if (!RESEND_API_KEY) {
    throw new Error("server not configured: set RESEND_INBOUND_API_KEY");
  }

  const res = await fetchWithTimeout(
    `https://api.resend.com/emails/receiving/${
      encodeURIComponent(providerEmailId)
    }`,
    { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } },
  );
  if (!res.ok) {
    throw new Error(
      `resend receiving ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const body = await res.json() as {
    text?: string | null;
    html?: string | null;
    subject?: string | null;
    from?: string | null;
    to?: string[] | null;
    cc?: string[] | null;
    headers?: unknown;
  };

  // The parser reads plain text. Most OTA mail carries both parts; when it does not,
  // strip the HTML rather than give up, because an email we cannot read is a booking
  // we cannot take.
  const text = (body.text ?? "").trim() || htmlToText(body.html ?? "");
  if (!text) throw new Error("email has no readable body");

  return {
    text,
    subject: body.subject ?? null,
    from: body.from ?? null,
    // Only the original To: list decides the business. See companyFor.
    recipients: originalRecipients(body),
  };
}

/**
 * The addresses the email was originally aimed at, in order.
 *
 * Make read these off its mailhook as `Recipients[1]` / `Recipients[2]`, which are
 * the original To: header. Resend's `to` is the ENVELOPE recipient, so after a
 * forward it is only our own inbound address and the header is the one place the
 * real destination survives. Read the header when it is there, fall back to `to`.
 *
 * `headers` arrives in whatever shape the API chooses: a name -> value map, a list
 * of `{name, value}` pairs, or the raw block as one string. Reading only one shape
 * fails silently, with every email looking like the fallback business, so all three
 * are handled. Order is preserved, because the rule is positional.
 */
function originalRecipients(
  body: { to?: string[] | null; headers?: unknown },
): string[] {
  const raw = toHeaderValue(body.headers);
  const list = raw
    ? raw.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []
    : (body.to ?? []).filter(Boolean).map(String);
  return list.map((v) => v.toLowerCase());
}

/** The To: header's value, whatever shape `headers` came in. */
function toHeaderValue(h: unknown): string | null {
  if (typeof h === "string") {
    const line = h.split("\n").find((l) => /^\s*to\s*:/i.test(l));
    return line ? line.replace(/^\s*to\s*:/i, "") : null;
  }
  if (Array.isArray(h)) {
    for (const entry of h) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const name = e.name ?? e.key;
        if (typeof name === "string" && name.trim().toLowerCase() === "to") {
          return e.value == null ? null : String(e.value);
        }
      }
    }
    return null;
  }
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (k.trim().toLowerCase() === "to" && v != null) return String(v);
    }
  }
  return null;
}

/**
 * The Bubble company id behind the recipients, matching the Make scenario exactly:
 *
 *   if(contains(74.Recipients[1]; KEY_WEST_INBOX) or
 *      contains(74.Recipients[2]; KEY_WEST_INBOX), KEY_WEST, MIAMI)
 *
 * The FIRST TWO addresses of the original To: header and nothing else. Not cc, not
 * delivered-to, not the x-forwarded-* headers. The rule is positional, so widening
 * it silently moves bookings between businesses. See originalRecipients for why the
 * header, rather than Resend's `to`, is what has to be read.
 */
export function companyFor(recipients: string[]): string {
  return recipients.slice(0, 2).some((r) => r.includes(KEY_WEST_INBOX))
    ? COMPANY_KEY_WEST
    : COMPANY_MIAMI;
}

/** Crude tag strip, only ever a fallback for an email with no text part. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Does an email the parser read NOTHING from still look like a reservation?
 *
 * The parser reads Bokun's labelled layout. An email where it finds neither a booking
 * reference nor a date is usually junk (a forwarding confirmation, a newsletter), and
 * that must not raise an alarm. But the first real email through here read as nothing
 * too: a mail client had wrapped every label in asterisks, and a real guest was filed
 * as "not a booking". So an empty read is only junk when the email carries none of the
 * labels a reservation has and its subject names no booking. Otherwise it is a booking
 * we could not read, and a person has to look. A false alarm costs a glance; a missed
 * guest costs a seat at the dock.
 */
export function looksLikeBooking(subject: string | null, text: string): boolean {
  const SUBJECT = /\b(booking|reservation|reserva|cancell?ed|amended)\b/i;
  const LABELS =
    /\b(booking ref|product booking ref|booking channel|customer email|customer phone|lead traveler|travel date)\b/i;
  return SUBJECT.test(subject ?? "") || LABELS.test(text);
}

/**
 * What the read could not find on an email it still booked, as stable codes (the
 * screen and the alert word them). Make refused to book when any of these came back
 * empty and pushed an alert instead; the Mailroom books what it can (a guest on the
 * manifest with a gap beats no guest) and says so.
 *
 * Only ALERT_WARNINGS text the owner: a wrong head count breaks the manifest and the
 * capacity count. A missing name (the booking lands as "Guest", 6 of the first 65) or
 * channel shows on the Mailroom screen only, because an alarm that fires several
 * times a day for a cosmetic gap gets muted, and then it misses the one that matters.
 * mailroom_claim_alerts carries the same list.
 */
export const ALERT_WARNINGS = ["no_guest_count", "guest_count_mismatch"];

export function warningsFor(booking: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const pax = Number(booking.adult ?? 0) + Number(booking.child ?? 0) +
    Number(booking.infant ?? 0);
  if (!(pax > 0)) warnings.push("no_guest_count");
  const diagnostics = booking.diagnostics as { paxMismatch?: boolean } | undefined;
  if (pax > 0 && diagnostics?.paxMismatch) warnings.push("guest_count_mismatch");
  if (!booking.customerName) warnings.push("no_guest_name");
  if (!booking.bookingChannel) warnings.push("no_channel");
  return warnings;
}

type ParseResponse = {
  ok?: boolean;
  error?: string;
  booking?: Record<string, unknown>;
  product_match?: {
    business_tour_id?: string | null;
    tour_name?: string | null;
    method?: string | null;
  } | null;
  queued?: { id?: string | null; status?: string | null } | null;
};

type SyncResult = {
  legacy_id: string | null;
  ok: boolean;
  error?: string;
  action?: "inserted" | "updated" | "echo" | "refused";
  booking_id?: string;
};

/** Time a step and add it to the trail, whatever its outcome. */
async function timed<T>(
  steps: Step[],
  step: Step["step"],
  run: () => Promise<{ value: T; note: string; data?: Record<string, unknown> }>,
): Promise<T> {
  const started = Date.now();
  const at = new Date(started).toISOString();
  try {
    const { value, note, data } = await run();
    steps.push({ step, ok: true, at, ms: Date.now() - started, note, data });
    return value;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    steps.push({ step, ok: false, at, ms: Date.now() - started, note: message });
    throw e;
  }
}

/**
 * One full pass over a row. Throws a PassError on anything that stops it (with the
 * steps so far); the caller counts the attempt and decides when to stop. Returns what
 * the row should become.
 */
export async function processInbound(row: InboundRow): Promise<ProcessOutcome> {
  const steps: Step[] = [];
  const learned: { raw_text?: string; recipients?: string[]; legacy_company_id?: string } =
    {};
  const stop = (e: unknown, permanent = false): never => {
    if (e instanceof PassError) throw e;
    throw new PassError(
      e instanceof Error ? e.message : String(e),
      steps,
      learned,
      permanent,
    );
  };

  if (!EMAIL_PARSE_SECRET) {
    stop(new Error("server not configured: set EMAIL_PARSE_SECRET"));
  }
  if (!XANO_WEBHOOK_SECRET) {
    stop(new Error("server not configured: set XANO_WEBHOOK_SECRET"));
  }

  // 1. The body. Kept on the row after the first pass, so later passes and any
  //    after-the-fact question about what we read cost Resend nothing.
  let text = row.raw_text ?? "";
  let subject = row.subject;
  let recipients = (row.to_addresses ?? []).map((s) => s.toLowerCase());
  await timed(steps, "fetch", async () => {
    const reused = Boolean(text);
    if (!text) {
      const mail = await fetchReceivedEmail(row.provider_email_id);
      text = mail.text;
      subject = subject ?? mail.subject;
      if (mail.recipients.length > 0) recipients = mail.recipients;
    }
    learned.raw_text = text;
    learned.recipients = recipients;
    return {
      value: null,
      note: reused
        ? "Used the copy kept from the first read"
        : `Fetched the email from Resend (${text.length.toLocaleString("en-US")} characters)`,
      data: { recipients: recipients.slice(0, 5) },
    };
  }).catch((e) => stop(e));

  const company = row.legacy_company_id ?? companyFor(recipients);
  learned.legacy_company_id = company;

  // 2. Read it. POST, not the GET the Make scenario used: an OTA email body is far
  //    past a safe URL length, and Make only got away with it by truncating nothing
  //    it happened to receive.
  const parsed = await timed(steps, "read", async () => {
    const parseRes = await fetchWithTimeout(
      `${SUPABASE_URL}/functions/v1/email-booking-parse`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": EMAIL_PARSE_SECRET,
        },
        body: JSON.stringify({ text, subject: subject ?? "", company }),
      },
    );
    const parseBody = await parseRes.json().catch(() => null) as
      | ParseResponse
      | null;
    if (!parseRes.ok || !parseBody?.ok) {
      throw new Error(
        `The reader answered ${parseRes.status}: ${
          parseBody?.error ?? "unreadable response"
        }`,
      );
    }
    const b = (parseBody.booking ?? {}) as Record<string, unknown>;
    const ref = (b.bookingReference ?? b.bookingRef ?? null) as string | null;
    const found = [
      ref ? `reference ${ref}` : null,
      b.startsAtNY ? String(b.startsAtNY) : null,
      b.customerName ? String(b.customerName) : null,
    ].filter(Boolean);
    return {
      value: parseBody,
      note: found.length > 0 ? `Read ${found.join(", ")}` : "Found no booking details",
      data: {
        reference: ref,
        status: b.status ?? null,
        date: b.startsAtNY ?? null,
        guest: b.customerName ?? null,
        phone: b.phone ?? null,
        email: b.email ?? null,
        adults: b.adult ?? 0,
        children: b.child ?? 0,
        infants: b.infant ?? 0,
        channel: b.bookingChannel ?? null,
        product: b.productName ?? null,
        tour: parseBody.product_match?.tour_name ?? null,
        matched_by: parseBody.product_match?.method ?? null,
        needs_tour: Boolean(parseBody.queued?.id),
      },
    };
  }).catch((e) => stop(e));

  const booking = (parsed.booking ?? {}) as Record<string, unknown>;
  const businessTourId = parsed.product_match?.business_tour_id ?? null;
  const matchQueueId = parsed.queued?.id ?? null;

  // 3. Is there anything to book? Mail that is not a reservation (a bounce, a
  //    newsletter, a report) reaches the same inbox, and it must not look like a
  //    failure or the alarm that matters gets buried under noise. But an email that
  //    reads as nothing while looking like a reservation is exactly the failure this
  //    pipeline exists to catch, so that one stops here for a person.
  const hasRef = Boolean(booking.bookingReference ?? booking.bookingRef);
  const hasDate = Boolean(booking.startsAtMs ?? booking.startsAtUtc);
  if (!hasRef && !hasDate) {
    if (looksLikeBooking(subject, text)) {
      // The reader answered fine, but it did not do its job: that is the step that
      // broke, so that is the one the screen marks.
      const readStep = steps.find((s) => s.step === "read");
      if (readStep) {
        readStep.ok = false;
        readStep.note = "Found no reference or date in an email that looks like a booking";
      }
      stop(
        new Error(
          "This looks like a booking, but no reference or date could be read from it",
        ),
        true,
      );
    }
    return {
      status: "parsed",
      raw_text: text,
      legacy_company_id: company,
      recipients,
      booking_id: null,
      business_tour_id: businessTourId,
      match_queue_id: matchQueueId,
      legacy_id: null,
      steps,
      warnings: [],
    };
  }

  // 4. Write the booking. Same fields the Make scenario mapped, same endpoint.
  const result = await timed(steps, "book", async () => {
    const syncRes = await fetchWithTimeout(
      `${SUPABASE_URL}/functions/v1/xano-booking-sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": XANO_WEBHOOK_SECRET,
          // Names this caller in booking_sync_log.
          "x-sync-source": "mailroom",
        },
        body: JSON.stringify({
          supplier: booking.supplier ?? null,
          company: booking.company ?? company,
          starts_at: booking.startsAtMs ?? null,
          status: booking.status ?? null,
          booking_channel: booking.bookingChannel ?? null,
          customer_name: booking.customerName ?? null,
          phone: booking.phone ?? null,
          email: booking.email ?? null,
          adult: booking.adult ?? 0,
          child: booking.child ?? 0,
          infant: booking.infant ?? 0,
          booking_reference: booking.bookingReference ?? null,
          checked: false,
          business_tour_id: businessTourId,
          // Marks a booking this email CREATES as ours to text. The sync sets it on
          // insert only, so an email that updates an older booking changes nothing.
          inbound_email_id: row.id,
        }),
      },
    );
    const syncBody = await syncRes.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      results?: SyncResult[];
    } | null;
    const r = syncBody?.results?.[0];
    if (!syncRes.ok || !syncBody?.ok || !r?.ok) {
      throw new Error(
        `The booking was refused (${syncRes.status}): ${
          r?.error ?? syncBody?.error ?? "unreadable response"
        }`,
      );
    }
    const note = r.action === "inserted"
      ? "Created a new booking"
      : r.action === "echo"
      ? "Matched a booking made on this platform"
      : "Updated the booking already on file";
    return {
      value: r,
      note,
      data: { action: r.action ?? null, booking_id: r.booking_id ?? null, key: r.legacy_id },
    };
  }).catch((e) => stop(e));

  return {
    status: "booked",
    raw_text: text,
    legacy_company_id: company,
    recipients,
    booking_id: result.booking_id ?? null,
    business_tour_id: businessTourId,
    match_queue_id: matchQueueId,
    legacy_id: result.legacy_id,
    steps,
    warnings: warningsFor(booking),
  };
}

/**
 * Run a pass and write what it found onto the row. Never throws.
 *
 * `giveUpAfter` is the attempt count at which a failure stops being retried and goes
 * to 'failed' (a person owns it from there). The webhook's first pass passes null: it
 * never gives up on its own, the sweep does. A permanent failure (an email that looks
 * like a booking but reads as nothing) goes to 'failed' on the spot either way.
 *
 * Alerts are not sent from here. The sweep claims every row that needs one
 * (mailroom_claim_alerts), so each is told exactly once, from one place.
 */
export async function runPass(
  sb: SupabaseClient,
  row: InboundRow & { attempts: number },
  giveUpAfter: number | null,
): Promise<string> {
  const attempts = row.attempts + 1;
  const startedAt = new Date().toISOString();
  try {
    const out = await processInbound(row);

    // The sync answers with the booking it wrote. Older answers carried only the
    // key, so fall back to finding the row by it.
    let bookingId = out.booking_id;
    if (!bookingId && out.legacy_id) {
      const { data } = await sb
        .from("bookings")
        .select("id")
        .eq("legacy_id", out.legacy_id)
        .maybeSingle();
      bookingId = (data?.id as string | undefined) ?? null;
    }

    await sb
      .from("inbound_emails")
      .update({
        status: out.status,
        raw_text: out.raw_text,
        legacy_company_id: out.legacy_company_id,
        to_addresses: out.recipients,
        booking_id: bookingId,
        business_tour_id: out.business_tour_id,
        match_queue_id: out.match_queue_id,
        steps: out.steps,
        warnings: out.warnings,
        attempts,
        last_attempt_at: startedAt,
        error: null,
      })
      .eq("id", row.id);
    return out.status;
  } catch (e) {
    const err = e instanceof PassError
      ? e
      : new PassError(e instanceof Error ? e.message : String(e), []);
    const done = err.permanent || (giveUpAfter != null && attempts >= giveUpAfter);
    await sb
      .from("inbound_emails")
      .update({
        status: done ? "failed" : "received",
        attempts,
        last_attempt_at: startedAt,
        error: err.message,
        steps: err.steps,
        // Keep what the pass already learned, so the next one does not ask Resend
        // again and a person can read the email while it is still failing.
        ...(err.learned.raw_text ? { raw_text: err.learned.raw_text } : {}),
        ...(err.learned.recipients?.length ? { to_addresses: err.learned.recipients } : {}),
        ...(err.learned.legacy_company_id
          ? { legacy_company_id: err.learned.legacy_company_id }
          : {}),
      })
      .eq("id", row.id);
    return done ? "failed" : "received";
  }
}
