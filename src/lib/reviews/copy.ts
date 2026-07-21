/**
 * The review funnel's messages. Fixed, not owner-editable.
 *
 * Staff will never author another flow shaped like this (it branches on the
 * reply and cancels itself), so it is a hardcoded funnel rather than rows in
 * messaging_rules. /admin/messaging shows these read-only with a single on/off.
 *
 * Wording is carried over from Xano so customers see the same texts they do
 * today: task 9 "execute timers" (ask, re-ask) and fn 269 (the two branches).
 */
export const REVIEW_COPY = {
  /** Step 1. Sent a few hours after the tour. The reply to this is the rating. */
  ask: (firstName: string) =>
    `Hi ${firstName}! We'd love to know how your experience was. Could you rate ` +
    "it 1 to 5, with 5 being the best? Your feedback helps us improve every day!",

  /**
   * Step 2. Only if they never answered at all. This one earns a lot of the
   * replies, which is why Xano keeps it and why it is not optional here.
   */
  reask: (firstName: string) =>
    `Hey ${firstName}, just a quick reminder in case you missed it. Could you ` +
    "rate your experience from 1 to 5? I really appreciate your time. Thanks again!",

  /** Step 3a. Rated 5. The only path that reaches Google. */
  link: (link: string) =>
    "Awesome, glad to hear that! If you have a minute, could you leave us a " +
    `quick Google review? It would mean a lot to us: ${link}`,

  /** Step 3b. Rated 1-4. Kept private on purpose, never reaches Google. */
  followup:
    "I'm really sorry that your experience was less than perfect. We truly care " +
    "about making things right. Could you share what we could have done better?",
} as const;

/** The funnel's steps, for the read-only card in /admin/messaging. */
export const REVIEW_STEPS = [
  {
    key: "ask",
    when: "3 hours after the tour ends",
    detail: "Only guests who were checked in. Cancelled if the booking is un-checked-in.",
    preview: REVIEW_COPY.ask("Alex"),
  },
  {
    key: "reask",
    when: "24 hours later, only if they never replied",
    detail: "Cancelled the moment they answer anything.",
    preview: REVIEW_COPY.reask("Alex"),
  },
  {
    key: "link",
    when: "They reply 5",
    detail: "Uses the Google review link set on the business.",
    preview: REVIEW_COPY.link("https://.../r/AB12CD"),
  },
  {
    key: "followup",
    when: "They reply 1 to 4",
    detail: "Never sent to Google. Their next message is saved as the comment.",
    preview: REVIEW_COPY.followup,
  },
] as const;
