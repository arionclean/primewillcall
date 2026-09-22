// Inbound OTA booking email -> booking. The Resend `email.received` webhook.
//
// This replaces the Make "Mailhook-sky trigger" scenario, which was the last thing
// standing between an OTA reservation email and this platform. Make's value was
// never the logic (two HTTP calls), it was the execution history: somewhere to see
// that an email arrived and what became of it. So the first thing this function does,
// before it parses anything, is write the inbound_emails row. Everything after that
// can fail and be retried; an email that reached us can never vanish.
//
// Flow:
//   1. Verify the signature (Standard Webhooks / Svix, as Resend sends it).
//   2. Record the row. Unique on the provider's email id, so Resend's own retries
//      and our sweep all converge on one row and one booking.
//   3. Try a full pass (body -> parse -> booking). A failure here is left on the row
//      for email-inbound-sweep to retry, and the caller still gets a 200: the email
//      is safely ours, and asking Resend to redeliver would only race the sweep.
//
// Auth: the signature is the guard, so this is deployed with JWT verification off
// (Resend cannot send a Supabase token). Set RESEND_WEBHOOK_SECRET or it refuses
// every request: an unauthenticated booking intake is worse than a broken one.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { withSentry } from "../_shared/sentry.ts";
import { processInbound } from "../_shared/inbound-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";

/** Replay window. Standard Webhooks' own recommendation. */
const MAX_SKEW_SECONDS = 300;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let r = 0;
  for (let i = 0; i < ea.length; i++) r |= ea[i] ^ eb[i];
  return r === 0;
}

/**
 * Standard Webhooks signature check.
 *
 * Signed content is `<id>.<timestamp>.<body>`, HMAC-SHA256 with the secret's base64
 * payload (the part after `whsec_`), compared against any of the space-separated
 * `v1,<sig>` entries. Resend sends the headers under both the `svix-` and the
 * vendor-neutral `webhook-` prefixes depending on age, so both are accepted.
 */
async function signatureOk(
  req: Request,
  body: string,
): Promise<{ ok: boolean; why?: string }> {
  const h = (name: string) =>
    req.headers.get(`svix-${name}`) ?? req.headers.get(`webhook-${name}`) ?? "";
  const id = h("id");
  const ts = h("timestamp");
  const sigHeader = h("signature");
  if (!id || !ts || !sigHeader) {
    return { ok: false, why: "missing signature headers" };
  }

  const sent = Number(ts);
  if (!Number.isFinite(sent)) return { ok: false, why: "bad timestamp" };
  if (Math.abs(Date.now() / 1000 - sent) > MAX_SKEW_SECONDS) {
    return { ok: false, why: "timestamp outside the replay window" };
  }

  const secret = WEBHOOK_SECRET.startsWith("whsec_")
    ? WEBHOOK_SECRET.slice("whsec_".length)
    : WEBHOOK_SECRET;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    // A secret that is not base64 is taken literally rather than refused: better a
    // working webhook than a silent 401 because the value was pasted unwrapped.
    keyBytes = new TextEncoder().encode(secret);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${ts}.${body}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  for (const part of sigHeader.split(" ")) {
    const [version, value] = part.split(",");
    if (version === "v1" && value && timingSafeEqual(value, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, why: "signature mismatch" };
}

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    headers?: Record<string, string>;
  };
};

/** Run a pass and write the result onto the row. Never throws. */
async function runPass(row: {
  id: string;
  provider_email_id: string;
  subject: string | null;
  raw_text: string | null;
  to_addresses: string[] | null;
  legacy_company_id: string | null;
  attempts: number;
}): Promise<string> {
  try {
    const out = await processInbound(row);

    // The sync answers with the booking key it upserted on; turn it into the row id
    // so the screen can link straight to the guest.
    let bookingId: string | null = null;
    if (out.legacy_id) {
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
        attempts: row.attempts + 1,
        last_attempt_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", row.id);
    return out.status;
  } catch (e) {
    // Stays 'received'. The sweep owns the retry and the giving-up, so that the
    // decision lives in one place instead of two.
    await sb
      .from("inbound_emails")
      .update({
        attempts: row.attempts + 1,
        last_attempt_at: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      })
      .eq("id", row.id);
    return "received";
  }
}

Deno.serve(withSentry("email-inbound", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!WEBHOOK_SECRET) {
    return json(
      { error: "server not configured: set RESEND_WEBHOOK_SECRET" },
      503,
    );
  }

  const body = await req.text();
  const sig = await signatureOk(req, body);
  if (!sig.ok) return json({ error: `unauthorized: ${sig.why}` }, 401);

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  // Resend can send other event types on the same endpoint (delivery, bounce). They
  // are not ours; acknowledge so it stops retrying.
  if (event.type !== "email.received") {
    return json({ ok: true, ignored: event.type ?? null }, 200);
  }

  const emailId = event.data?.email_id;
  if (!emailId) return json({ error: "event has no data.email_id" }, 400);

  const recipients = [
    ...(event.data?.to ?? []),
    ...(event.data?.cc ?? []),
    ...Object.entries(event.data?.headers ?? {})
      .filter(([k]) =>
        ["to", "cc", "delivered-to", "x-forwarded-to"].includes(k.toLowerCase())
      )
      .map(([, v]) => String(v)),
  ].map((s) => s.toLowerCase());

  // Record first, work second. An insert that conflicts means this email is already
  // ours (a Resend retry, or the sweep beat us here), and the existing row wins.
  const { error: insertError } = await sb.from("inbound_emails").insert({
    provider: "resend",
    provider_email_id: emailId,
    from_address: event.data?.from ?? null,
    to_addresses: recipients,
    subject: event.data?.subject ?? null,
    // NOT decided here. The webhook carries the ENVELOPE recipient, which after a
    // forward is only our own inbound address, so deciding from it would pin every
    // email to the fallback business before the real headers are ever read. The
    // first pass resolves it from the fetched To: header. See companyFor.
    legacy_company_id: null,
  });
  if (insertError && insertError.code !== "23505") {
    // The log itself failed. This is the one error worth making Resend retry, since
    // without the row nothing downstream would ever look at this email again.
    return json(
      { error: `could not record the email: ${insertError.message}` },
      500,
    );
  }

  const { data: row } = await sb
    .from("inbound_emails")
    .select(
      "id, provider_email_id, subject, raw_text, to_addresses, legacy_company_id, attempts, status",
    )
    .eq("provider", "resend")
    .eq("provider_email_id", emailId)
    .single();
  if (!row) return json({ error: "row vanished after insert" }, 500);

  // Already finished on an earlier delivery: acknowledge and touch nothing.
  if (
    row.status === "booked" || row.status === "parsed" ||
    row.status === "ignored"
  ) {
    return json(
      { ok: true, id: row.id, status: row.status, duplicate: true },
      200,
    );
  }

  const status = await runPass(row);
  return json({ ok: true, id: row.id, status }, 200);
}));
