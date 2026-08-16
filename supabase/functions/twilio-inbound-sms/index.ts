// Twilio inbound-SMS webhook, Supabase-native (Deno) port of the Vercel route
// src/app/api/webhooks/twilio/sms/route.ts. Configure this URL as the Messaging webhook
// ("A message comes in") on the Twilio number.
//
// Deployed with JWT off: Twilio does not send a Supabase token; the X-Twilio-Signature
// header is the auth. The signature is an HMAC-SHA1 over the exact webhook URL plus the
// sorted form fields, so the URL we verify against must match what Twilio is configured
// with, character for character. It is built from SUPABASE_URL unless TWILIO_WEBHOOK_URL
// overrides it.
//
// Behaviour is identical to the route it replaces:
//   1. verify the signature (skip only if TWILIO_VALIDATE_SIGNATURE=false)
//   2. mirror the raw payload to Xano so its flows keep working during coexistence
//   3. log the message, linking it to a customer by phone
//   4. STOP/START keywords flip sms_opt_outs and stop there
//   5. otherwise offer it to the review funnel (inert while
//      messaging_settings.review_automation_enabled is false)
// It always answers 200 with empty TwiML, or Twilio retries the message.
//
// Secrets: TWILIO_AUTH_TOKEN, GROQ_API_KEY (optional, review classifier fallback),
// XANO_SMS_FORWARD_URL (set to "" to stop mirroring), APP_URL (review link base),
// TWILIO_VALIDATE_SIGNATURE (optional, "false" disables the check).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import {
  AUTH_TOKEN,
  classifyOptKeyword,
  db as sb,
  isOptedOut,
  logSmsMessage,
  normalizeUsPhone,
  phoneVariants,
  setOptOut,
  SUPABASE_URL,
} from "../_shared/sms.ts";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://primewillcall.vercel.app").replace(/\/+$/, "");

// While Xano coexists, mirror every webhook to its endpoint so notifications and reply
// handling there keep working. Set XANO_SMS_FORWARD_URL="" to stop.
const XANO_FORWARD_DEFAULT =
  "https://xmhi-aj9d-cnsb.n7.xano.io/api:M7vqYZvJ/receive/sms_respose_twilio";
const XANO_FORWARD_URL = Deno.env.get("XANO_SMS_FORWARD_URL") ?? XANO_FORWARD_DEFAULT;

const WEBHOOK_URL =
  Deno.env.get("TWILIO_WEBHOOK_URL") ?? `${SUPABASE_URL}/functions/v1/twilio-inbound-sms`;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(status = 200): Response {
  return new Response(EMPTY_TWIML, { status, headers: { "content-type": "text/xml" } });
}

/* -------------------------------------------------------------- signature */

/** base64(HMAC-SHA1(authToken, url + sortedKey1 + value1 + sortedKey2 + value2 ...)). */
async function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !AUTH_TOKEN) return false;

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Constant-time-ish compare: same length, no early exit.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------- xano */

async function forwardToXano(params: Record<string, string>): Promise<void> {
  if (!XANO_FORWARD_URL) return;
  try {
    await fetch(XANO_FORWARD_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("Failed to forward SMS webhook to Xano:", error);
  }
}

/* ---------------------------------------------------- review funnel copy */

// Mirrors src/lib/reviews/copy.ts. Keep the two in sync: customers must see the
// same wording whichever side sends it.
const REVIEW_COPY = {
  link: (link: string) =>
    "Awesome, glad to hear that! If you have a minute, could you leave us a " +
    `quick Google review? It would mean a lot to us: ${link}`,
  followup:
    "I'm really sorry that your experience was less than perfect. We truly care " +
    "about making things right. Could you share what we could have done better?",
} as const;

const REVIEW_TAGS = {
  ask: "review_ask",
  reask: "review_reask",
  link: "review_link",
  followup: "review_followup",
} as const;

const REVIEW_TAG_LIST: string[] = Object.values(REVIEW_TAGS);
/** The two sends whose reply should be read as a 1-5 rating. */
const RATING_PROMPT_TAGS: string[] = [REVIEW_TAGS.ask, REVIEW_TAGS.reask];
/** How long after the ask an inbound reply still counts as a response to it. */
const REPLY_WINDOW_HOURS = 168;

/* ------------------------------------------------- rating classification */

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * Matches only unambiguous ratings: "5", "5!", "5/5", "5 stars", "five".
 * Anything chattier ("4 of us had a blast") deliberately falls through to the
 * model rather than risk reading a pax count as a rating.
 */
function parseRating(body: string): number | null {
  const text = body.trim().toLowerCase().replace(/\s+/g, " ");
  const numeric = text.match(/^([1-5])\s*(?:\/\s*5)?\s*(?:stars?|\*+)?\s*[.!]*$/);
  if (numeric) return Number(numeric[1]);
  const word = text.match(/^(one|two|three|four|five)\s*(?:stars?)?\s*[.!]*$/);
  if (word) return WORD_NUMBERS[word[1]] ?? null;
  return null;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";

async function classifyWithGroq(body: string): Promise<number | null> {
  if (!GROQ_API_KEY) return null;
  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_TEXT_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'A tour company asked a customer: "How would you rate the tour from 1 to 5, ' +
              '5 being excellent?" Classify the customer reply as a rating from 1 to 5. ' +
              "If they say it was great, perfect or amazing and mention no downsides, that is a 5. " +
              "If the reply carries no opinion about the tour at all (a question, a greeting, " +
              "an unrelated message), it has no rating. " +
              'Respond only as JSON: {"rating": <integer 1-5, or null>}.',
          },
          { role: "user", content: body },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("Review classifier: Groq returned", response.status);
      return null;
    }
    const json = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { rating?: unknown };
    const rating = Number(parsed.rating);
    return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
  } catch (error) {
    // Never let the classifier break the inbound webhook.
    console.error("Review classifier failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function classifyRating(
  body: string,
): Promise<{ kind: "rating"; rating: number } | { kind: "unclear" }> {
  const parsed = parseRating(body);
  if (parsed !== null) return { kind: "rating", rating: parsed };
  const modelled = await classifyWithGroq(body);
  if (modelled !== null) return { kind: "rating", rating: modelled };
  return { kind: "unclear" };
}

/* -------------------------------------------------------- review funnel */

/** Cancel this funnel's still-queued sends for one phone. */
async function cancelPendingReviewSends(phone: string): Promise<void> {
  const { error } = await sb
    .from("scheduled_messages")
    .update({ status: "canceled" })
    .eq("status", "pending")
    .in("tag", REVIEW_TAG_LIST)
    .eq("to_phone", phone);
  if (error) console.error("Failed to cancel queued review sends:", error.message);
}

/**
 * The tag on the most recent thing we sent this number.
 *
 * Has to consider both tables: the dispatcher sends queued messages without
 * mirroring them into sms_messages, while inline and manual sends only ever
 * land in sms_messages. Reading one of them alone gives the wrong answer.
 */
async function lastOutboundTag(phone: string): Promise<string | null> {
  const [queued, logged] = await Promise.all([
    sb
      .from("scheduled_messages")
      .select("tag, sent_at")
      .eq("to_phone", phone)
      .eq("status", "sent")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1),
    sb
      .from("sms_messages")
      .select("tag, created_at")
      .eq("to_phone", phone)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const q = queued.data?.[0];
  const l = logged.data?.[0];
  if (!q && !l) return null;
  if (!q) return l?.tag ?? null;
  if (!l) return q.tag ?? null;
  return new Date(q.sent_at as string) >= new Date(l.created_at as string) ? q.tag : l.tag;
}

/** Queue an SMS for the dispatcher. Never sends directly, so the hourly cap still governs spend. */
async function enqueueReviewSms(opts: {
  toPhone: string;
  body: string;
  tag: string;
  businessId: string | null;
  bookingId: string | null;
  customerId: string | null;
}): Promise<boolean> {
  if (await isOptedOut(opts.toPhone)) return false;
  const { error } = await sb.from("scheduled_messages").insert({
    to_phone: opts.toPhone,
    channel: "sms",
    body: opts.body,
    business_id: opts.businessId,
    booking_id: opts.bookingId,
    customer_id: opts.customerId,
    tag: opts.tag,
    send_at: new Date().toISOString(),
    status: "pending",
  });
  if (error) {
    console.error("Failed to enqueue review SMS:", error.message);
    return false;
  }
  return true;
}

/**
 * Handle one inbound SMS as a possible review reply. Port of
 * handleInboundReviewReply in src/lib/reviews/funnel.ts; the rules that are easy
 * to miss are kept verbatim:
 *
 *  - ANY inbound reply cancels this customer's queued review sends, so someone
 *    who answers straight away is not nagged 24h later.
 *  - A reply only counts as a rating if the LAST thing we sent was the ask or
 *    the re-ask, so an unrelated "5" never fires the Google link.
 *  - A reply to the 1-4 follow-up is stored as the comment, not re-classified.
 *  - A reply we cannot read as a rating is recorded and sends nothing.
 */
async function handleInboundReviewReply(fromPhone: string, body: string): Promise<void> {
  const { data: settings } = await sb
    .from("messaging_settings")
    .select("review_automation_enabled")
    .eq("id", true)
    .maybeSingle();
  if (!settings?.review_automation_enabled) return;

  const phone = normalizeUsPhone(fromPhone);
  if (!phone) return;

  // Any reply at all stops the queued nudge, decided before we know if it is a rating.
  await cancelPendingReviewSends(phone);

  const lastTag = await lastOutboundTag(phone);
  const isRatingReply = lastTag !== null && RATING_PROMPT_TAGS.includes(lastTag);
  const isFeedbackReply = lastTag === REVIEW_TAGS.followup;
  if (!isRatingReply && !isFeedbackReply) return;

  const { data: customerRows } = await sb
    .from("customers")
    .select("id")
    .in("phone", phoneVariants(phone));
  const customerIds = (customerRows ?? []).map((c) => c.id);
  if (customerIds.length === 0) return;

  const since = new Date(Date.now() - REPLY_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: reviewRows } = await sb
    .from("reviews")
    .select("id, business_id, booking_id, customer_id, token, rating, comment")
    .in("customer_id", customerIds)
    .not("asked_at", "is", null)
    .is("cancelled_at", null)
    .gte("asked_at", since)
    .order("asked_at", { ascending: false })
    .limit(1);

  const review = reviewRows?.[0];
  if (!review) return;

  const now = new Date().toISOString();

  // They already rated 1-4 and we asked what went wrong, so this is that answer.
  if (isFeedbackReply) {
    if (review.comment) return;
    await sb.from("reviews").update({ comment: body }).eq("id", review.id);
    return;
  }

  if (review.rating !== null) return;

  const classification = await classifyRating(body);
  if (classification.kind === "unclear") {
    // Do not guess. Record what they said, send nothing, and leave the ask open
    // so a later "5" still counts.
    await sb.from("reviews").update({ comment: body }).eq("id", review.id);
    return;
  }

  const rating = classification.rating;

  if (rating >= 5) {
    const { data: business } = await sb
      .from("businesses")
      .select("google_review_url")
      .eq("id", review.business_id)
      .maybeSingle();
    const target = (business?.google_review_url ?? "").trim();

    if (!target) {
      // Nothing to point them at, so bank the rating and stay quiet.
      await sb.from("reviews").update({ rating, responded_at: now }).eq("id", review.id);
      return;
    }

    const queued = await enqueueReviewSms({
      toPhone: phone,
      body: REVIEW_COPY.link(`${APP_URL}/r/${review.token}`),
      tag: REVIEW_TAGS.link,
      businessId: review.business_id,
      bookingId: review.booking_id,
      customerId: review.customer_id,
    });
    await sb
      .from("reviews")
      .update({ rating, responded_at: now, link_sent_at: queued ? now : null })
      .eq("id", review.id);
    return;
  }

  // 1-4: kept off Google on purpose. Ask privately what went wrong instead,
  // and their next message becomes the comment.
  await enqueueReviewSms({
    toPhone: phone,
    body: REVIEW_COPY.followup,
    tag: REVIEW_TAGS.followup,
    businessId: review.business_id,
    bookingId: review.booking_id,
    customerId: review.customer_id,
  });
  await sb.from("reviews").update({ rating, responded_at: now }).eq("id", review.id);
}

/* ------------------------------------------------------------ the handler */

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") params[key] = value;
  });

  // Set TWILIO_VALIDATE_SIGNATURE=false only for local dev.
  if (Deno.env.get("TWILIO_VALIDATE_SIGNATURE") !== "false") {
    const signature = req.headers.get("x-twilio-signature");
    if (!(await validateTwilioSignature(WEBHOOK_URL, params, signature))) {
      return new Response("Invalid Twilio signature", { status: 403 });
    }
  }

  // Keep Xano's copy of the flow alive during coexistence.
  await forwardToXano(params);

  // Same guard the Xano endpoint used: only handle real inbound messages.
  if (params.SmsStatus !== "received") return twiml();

  const body = params.Body ?? "";

  await logSmsMessage({
    direction: "inbound",
    from_phone: normalizeUsPhone(params.From) ?? params.From ?? "",
    to_phone: normalizeUsPhone(params.To) ?? params.To ?? "",
    body,
    status: "received",
    twilio_sid: params.MessageSid ?? null,
  });

  const optAction = classifyOptKeyword(body);
  if (optAction) {
    const phone = normalizeUsPhone(params.From) ?? params.From;
    if (phone) await setOptOut(phone, optAction === "opt_out", body.trim().toUpperCase());
    // STOP/START are never a review reply, so stop here.
    return twiml();
  }

  try {
    await handleInboundReviewReply(params.From ?? "", body);
  } catch (error) {
    // An inbound webhook must always 200, or Twilio retries the message.
    console.error("Review reply handling failed:", error);
  }

  return twiml();
});
