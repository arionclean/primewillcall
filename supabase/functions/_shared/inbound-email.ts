// Turning one inbound OTA email into a booking.
//
// Shared by the two halves of the intake so they can never drift: email-inbound
// (the Resend webhook, first pass) and email-inbound-sweep (the cron, every later
// pass). Both call processInbound() on an inbound_emails row and both get the same
// steps in the same order.
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
};

/** fetch with a deadline: a hung dependency must fail the pass, not hold the cron. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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
export async function fetchReceivedEmail(providerEmailId: string): Promise<ReceivedEmail> {
  if (!RESEND_API_KEY) throw new Error("server not configured: set RESEND_INBOUND_API_KEY");

  const res = await fetchWithTimeout(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(providerEmailId)}`,
    { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } },
  );
  if (!res.ok) {
    throw new Error(`resend receiving ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json() as {
    text?: string | null;
    html?: string | null;
    subject?: string | null;
    from?: string | null;
    to?: string[] | null;
    cc?: string[] | null;
    headers?: Record<string, string> | null;
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
    recipients: recipientsOf(body, text),
  };
}

/** Every address the email was aimed at, envelope and headers alike, lowercased. */
function recipientsOf(body: {
  to?: string[] | null;
  cc?: string[] | null;
  headers?: Record<string, string> | null;
}, text = ""): string[] {
  const out: string[] = [];
  for (const v of [...(body.to ?? []), ...(body.cc ?? [])]) if (v) out.push(v);

  // The mail reaches us FORWARDED from the business mailbox, so the envelope
  // recipient is our own inbound address and the address that decides the business
  // survives only in the headers. Miss these and every email looks like Miami.
  const h = body.headers ?? {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (
      key === "to" || key === "cc" || key === "delivered-to" ||
      key === "x-forwarded-to" || key === "x-original-to" || key === "x-forwarded-for"
    ) {
      if (v) out.push(String(v));
    }
  }

  out.push(...recipientsInText(text));
  return out.map((s) => s.toLowerCase());
}

/**
 * The addresses written into the body's forwarded header block.
 *
 * A mailbox rule forwards the message intact and the real headers survive. A person
 * forwarding by hand does not: the client builds a NEW message to us and writes the
 * original "To:" into the body, above the quoted text. Read that block too, or a
 * hand-forwarded Key West booking is filed under Miami and nothing looks wrong until
 * the guest reaches the wrong dock. Only To/Cc lines, so the customer's own address
 * further down is never mistaken for ours.
 *
 * Kept separate because a retry works from the stored raw_text with no Resend call,
 * and it has to reach the same answer as the first pass.
 */
export function recipientsInText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.slice(0, 4000).split("\n")) {
    if (!/^\s*(to|cc):/i.test(line)) continue;
    for (const addr of line.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []) {
      out.push(addr.toLowerCase());
    }
  }
  return out;
}

/** The Bubble company id behind the recipients. See the note on KEY_WEST_INBOX. */
export function companyFor(recipients: string[]): string {
  return recipients.some((r) => r.includes(KEY_WEST_INBOX)) ? COMPANY_KEY_WEST : COMPANY_MIAMI;
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

type ParseResponse = {
  ok?: boolean;
  error?: string;
  booking?: Record<string, unknown>;
  product_match?: { business_tour_id?: string | null } | null;
  queued?: { id?: string | null; status?: string | null } | null;
};

/**
 * One full pass over a row. Throws on anything that is worth another go; the caller
 * counts the attempt and decides when to stop. Returns what the row should become.
 */
export async function processInbound(row: InboundRow): Promise<ProcessOutcome> {
  if (!EMAIL_PARSE_SECRET) throw new Error("server not configured: set EMAIL_PARSE_SECRET");
  if (!XANO_WEBHOOK_SECRET) throw new Error("server not configured: set XANO_WEBHOOK_SECRET");

  // 1. The body. Kept on the row after the first pass, so later passes and any
  //    after-the-fact question about what we read cost Resend nothing.
  let text = row.raw_text ?? "";
  let subject = row.subject;
  let recipients = (row.to_addresses ?? []).map((s) => s.toLowerCase());
  if (!text) {
    const mail = await fetchReceivedEmail(row.provider_email_id);
    text = mail.text;
    subject = subject ?? mail.subject;
    if (mail.recipients.length > 0) recipients = mail.recipients;
  }
  // Whatever the body says it was addressed to counts on every pass, not just the
  // one that fetched it. See recipientsInText.
  recipients = [...recipients, ...recipientsInText(text)];

  const company = row.legacy_company_id ?? companyFor(recipients);

  // 2. Parse. POST, not the GET the Make scenario used: an OTA email body is far
  //    past a safe URL length, and Make only got away with it by truncating nothing
  //    it happened to receive.
  const parseRes = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/email-booking-parse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": EMAIL_PARSE_SECRET,
    },
    body: JSON.stringify({ text, subject: subject ?? "", company }),
  });
  const parseBody = await parseRes.json().catch(() => null) as ParseResponse | null;
  if (!parseRes.ok || !parseBody?.ok) {
    throw new Error(
      `parse ${parseRes.status}: ${parseBody?.error ?? "unreadable response"}`,
    );
  }

  const booking = (parseBody.booking ?? {}) as Record<string, unknown>;
  const businessTourId = parseBody.product_match?.business_tour_id ?? null;
  const matchQueueId = parseBody.queued?.id ?? null;

  // 3. Is there anything to book? Mail that is not a reservation (a bounce, a
  //    newsletter, a report) reaches the same inbox, and it must not look like a
  //    failure or the alarm that matters gets buried under noise.
  const hasRef = Boolean(booking.bookingReference ?? booking.bookingRef);
  const hasDate = Boolean(booking.startsAtMs ?? booking.startsAtUtc);
  if (!hasRef && !hasDate) {
    return {
      status: "parsed",
      raw_text: text,
      legacy_company_id: company,
      booking_id: null,
      business_tour_id: businessTourId,
      match_queue_id: matchQueueId,
      legacy_id: null,
    };
  }

  // 4. Write the booking. Same fields the Make scenario mapped, same endpoint.
  const syncRes = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/xano-booking-sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": XANO_WEBHOOK_SECRET,
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
    }),
  });
  const syncBody = await syncRes.json().catch(() => null) as {
    ok?: boolean;
    error?: string;
    results?: { legacy_id: string | null; ok: boolean; error?: string }[];
  } | null;
  const result = syncBody?.results?.[0];
  if (!syncRes.ok || !syncBody?.ok || !result?.ok) {
    throw new Error(
      `sync ${syncRes.status}: ${result?.error ?? syncBody?.error ?? "unreadable response"}`,
    );
  }

  return {
    status: "booked",
    raw_text: text,
    legacy_company_id: company,
    booking_id: null, // the caller resolves it from legacy_id; it holds the db client
    business_tour_id: businessTourId,
    match_queue_id: matchQueueId,
    legacy_id: result.legacy_id,
  };
}
