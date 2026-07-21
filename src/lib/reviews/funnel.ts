/**
 * The review funnel's stateful half: replies, and everything that cancels it.
 *
 * Ported from Xano fn 269 "analyze inbound message_v2" plus the cancellation
 * rules scattered across fn 94 "add to flowList DB" (uncheck), fn 101
 * "stopTask" (link click) and task 9 "execute timers" (the re-ask).
 *
 * The rules that are easy to miss, and why each one matters:
 *
 *  - ANY inbound reply cancels this customer's queued review sends. Without
 *    this, someone who answers straight away still gets nagged 24h later.
 *  - A reply only counts as a rating if the LAST thing we sent them was the
 *    ask or the re-ask. Otherwise a "5" in an unrelated conversation would
 *    fire the Google link at someone who never rated anything.
 *  - A reply to the 1-4 follow-up is stored as the comment, not re-classified.
 *  - A reply we cannot read as a rating is recorded and sends nothing, rather
 *    than guessing at a score.
 *
 * Nothing here calls Twilio. Sends are queued into scheduled_messages so the
 * dispatcher's global hourly cap still governs spend.
 *
 * Inert unless messaging_settings.review_automation_enabled is true.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeUsPhone } from "@/lib/sms/format";
import { isOptedOut } from "@/lib/sms/messages";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import { classifyRating } from "./classify";
import { REVIEW_COPY } from "./copy";

type Db = SupabaseClient<Database>;

export const REVIEW_TAGS = {
  ask: "review_ask",
  reask: "review_reask",
  link: "review_link",
  followup: "review_followup",
} as const;

/** Every tag this funnel queues, for cancellation sweeps. */
export const REVIEW_TAG_LIST: string[] = Object.values(REVIEW_TAGS);

/** The two sends whose reply should be read as a 1-5 rating. */
const RATING_PROMPT_TAGS: string[] = [REVIEW_TAGS.ask, REVIEW_TAGS.reask];

/** How long after the ask an inbound reply still counts as a response to it. */
const REPLY_WINDOW_HOURS = 168;

export type CancelReason = "unchecked" | "replied" | "clicked_link";

export interface ReviewReplyOutcome {
  handled: boolean;
  reason?: string;
  rating?: number;
}

/** Public URL of the tracked review link that /r/[token] redirects from. */
export function reviewLink(token: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return `${base}/r/${token}`;
}

/**
 * Cancel this funnel's still-queued sends. Xano's stopTask, generalised.
 * Scope by phone (the customer engaged) or by booking (it was un-checked-in).
 */
export async function cancelPendingReviewSends(
  db: Db,
  scope: { phone?: string; bookingId?: string },
): Promise<number> {
  let query = db
    .from("scheduled_messages")
    .update({ status: "canceled" })
    .eq("status", "pending")
    .in("tag", REVIEW_TAG_LIST)
    .select("id");

  if (scope.phone) query = query.eq("to_phone", scope.phone);
  if (scope.bookingId) query = query.eq("booking_id", scope.bookingId);

  const { data, error } = await query;
  if (error) {
    console.error("Failed to cancel queued review sends:", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

/**
 * The tag on the most recent thing we sent this number.
 *
 * Has to consider both tables: the dispatcher sends queued messages without
 * mirroring them into sms_messages, while inline and manual sends only ever
 * land in sms_messages. Reading one of them alone gives the wrong answer.
 */
async function lastOutboundTag(db: Db, phone: string): Promise<string | null> {
  const [queued, logged] = await Promise.all([
    db
      .from("scheduled_messages")
      .select("tag, sent_at")
      .eq("to_phone", phone)
      .eq("status", "sent")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1),
    db
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

  return new Date(q.sent_at as string) >= new Date(l.created_at) ? q.tag : l.tag;
}

/** Queue an SMS for the dispatcher. Never sends directly. */
export async function enqueueReviewSms(
  db: Db,
  opts: {
    toPhone: string;
    body: string;
    tag: string;
    businessId: string | null;
    bookingId: string | null;
    customerId: string | null;
    sendAt?: string;
  },
): Promise<boolean> {
  if (await isOptedOut(opts.toPhone)) {
    return false;
  }
  const { error } = await db.from("scheduled_messages").insert({
    to_phone: opts.toPhone,
    channel: "sms",
    body: opts.body,
    business_id: opts.businessId,
    booking_id: opts.bookingId,
    customer_id: opts.customerId,
    tag: opts.tag,
    send_at: opts.sendAt ?? new Date().toISOString(),
    status: "pending",
  });
  if (error) {
    console.error("Failed to enqueue review SMS:", error.message);
    return false;
  }
  return true;
}

/**
 * Stop the funnel for one booking. Called when a booking is un-checked-in:
 * Xano deletes that booking's timers in fn 94, because a guest who was checked
 * in by mistake must never be asked how their tour was.
 */
export async function cancelReviewForBooking(
  bookingId: string,
  reason: CancelReason,
): Promise<void> {
  const db = getSupabaseAdminClient();
  if (!db) return;

  await cancelPendingReviewSends(db, { bookingId });
  await db
    .from("reviews")
    .update({ cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq("booking_id", bookingId)
    .is("cancelled_at", null);
}

/**
 * Handle one inbound SMS as a possible review reply.
 *
 * Returns handled:false (with a reason) when the message is not part of a
 * review conversation, so the caller carries on with its other handling.
 */
export async function handleInboundReviewReply(input: {
  fromPhone: string;
  body: string;
}): Promise<ReviewReplyOutcome> {
  const db = getSupabaseAdminClient();
  if (!db) {
    return { handled: false, reason: "service role not configured" };
  }

  const { data: settings } = await db
    .from("messaging_settings")
    .select("review_automation_enabled")
    .eq("id", true)
    .maybeSingle();
  if (!settings?.review_automation_enabled) {
    return { handled: false, reason: "review automation disabled" };
  }

  const phone = normalizeUsPhone(input.fromPhone);
  if (!phone) {
    return { handled: false, reason: "not a US number" };
  }

  // Rule: any reply at all stops the queued nudge. Do this before deciding
  // whether the message is a rating, exactly as Xano does.
  await cancelPendingReviewSends(db, { phone });

  // Rule: only treat this as a rating if the ask really was the last thing we
  // sent. This is what stops an unrelated "5" from firing the Google link.
  const lastTag = await lastOutboundTag(db, phone);
  const isRatingReply = lastTag !== null && RATING_PROMPT_TAGS.includes(lastTag);
  const isFeedbackReply = lastTag === REVIEW_TAGS.followup;
  if (!isRatingReply && !isFeedbackReply) {
    return { handled: false, reason: `last outbound was ${lastTag ?? "nothing"}` };
  }

  // Phones arrived from the Xano import in mixed formats, so match the same
  // variants the SMS logger does.
  const national = phone.slice(2);
  const { data: customerRows } = await db
    .from("customers")
    .select("id")
    .in("phone", [phone, national, `1${national}`]);
  const customerIds = (customerRows ?? []).map((c) => c.id);
  if (customerIds.length === 0) {
    return { handled: false, reason: "no matching customer" };
  }

  const since = new Date(Date.now() - REPLY_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: reviewRows } = await db
    .from("reviews")
    .select("id, business_id, booking_id, customer_id, token, rating, comment")
    .in("customer_id", customerIds)
    .not("asked_at", "is", null)
    .is("cancelled_at", null)
    .gte("asked_at", since)
    .order("asked_at", { ascending: false })
    .limit(1);

  const review = reviewRows?.[0];
  if (!review) {
    return { handled: false, reason: "no open review ask" };
  }

  const now = new Date().toISOString();

  // They already rated 1-4 and we asked what went wrong, so this is that answer.
  if (isFeedbackReply) {
    if (review.comment) {
      return { handled: false, reason: "feedback already captured" };
    }
    await db.from("reviews").update({ comment: input.body }).eq("id", review.id);
    return { handled: true, rating: review.rating ?? undefined };
  }

  if (review.rating !== null) {
    return { handled: false, reason: "already rated" };
  }

  const classification = await classifyRating(input.body);
  if (classification.kind === "unclear") {
    // Do not guess. Record what they said, send nothing, and leave the ask
    // open so a later "5" still counts. Xano pinged staff here; we do not,
    // since the message already lands in the Messages inbox.
    await db.from("reviews").update({ comment: input.body }).eq("id", review.id);
    return { handled: false, reason: "reply was not a rating" };
  }

  const rating = classification.rating;

  if (rating >= 5) {
    const { data: business } = await db
      .from("businesses")
      .select("google_review_url")
      .eq("id", review.business_id)
      .maybeSingle();
    const target = (business?.google_review_url ?? "").trim();

    if (!target) {
      // Nothing to point them at, so bank the rating and stay quiet.
      await db
        .from("reviews")
        .update({ rating, responded_at: now })
        .eq("id", review.id);
      return { handled: true, rating, reason: "business has no google_review_url" };
    }

    const queued = await enqueueReviewSms(db, {
      toPhone: phone,
      body: REVIEW_COPY.link(reviewLink(review.token)),
      tag: REVIEW_TAGS.link,
      businessId: review.business_id,
      bookingId: review.booking_id,
      customerId: review.customer_id,
    });
    await db
      .from("reviews")
      .update({ rating, responded_at: now, link_sent_at: queued ? now : null })
      .eq("id", review.id);
    return { handled: true, rating };
  }

  // 1-4: kept off Google on purpose. Ask privately what went wrong instead,
  // and their next message becomes the comment.
  await enqueueReviewSms(db, {
    toPhone: phone,
    body: REVIEW_COPY.followup,
    tag: REVIEW_TAGS.followup,
    businessId: review.business_id,
    bookingId: review.booking_id,
    customerId: review.customer_id,
  });
  await db.from("reviews").update({ rating, responded_at: now }).eq("id", review.id);
  return { handled: true, rating };
}
