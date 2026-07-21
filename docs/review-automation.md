# Review funnel (post-tour rating)

Texts guests after their tour, asks for a 1-5 rating, and routes them by score.
Ported from Xano, rebuilt on the queue this app already has.

**Status: built and deployed, switched OFF.** Nothing sends until
`messaging_settings.review_automation_enabled` is flipped. Read "Why it must
stay off" first.

## The flow

```
guest checked in
   |
   +-- tour ends + 3h --> "How was it? Reply 1-5"          (review_ask)
                              |
                              +-- no reply after 24h --> one nudge   (review_reask)
                              |
                              +-- reply 5    --> Google review link  (review_link)
                              |                    |
                              |                    +-- click --> tracked, funnel stops
                              |
                              +-- reply 1-4  --> "What could we have done better?"
                              |                                      (review_followup)
                              |                    |
                              |                    +-- next message saved as the comment
                              |
                              +-- not a rating --> saved, nothing sent, ask stays open
```

Ratings of 1-4 never reach Google. Inherited from Xano, a deliberate product
choice. Google's own policy discourages it, so it is worth revisiting.

## It is a fixed flow, not an automation

The funnel branches on the customer's reply and cancels itself on uncheck.
`messaging_rules` has no conditions, so this cannot be a rule, and staff will
never author another flow shaped like it. So:

- the four messages live in `src/lib/reviews/copy.ts`, not in the database
- `/admin/messaging` shows all four steps **read-only** with one on/off switch
- `after_tour` is deliberately NOT a trigger in `TRIGGERS` / `ALLOWED_TRIGGERS`

An earlier cut modelled the ask as an editable rule. That was wrong and was
reverted in `20260721130000_review_funnel_rules.sql`.

## Every Xano rule, and where it lives here

| Xano | Here |
| --- | --- |
| Ask scheduled at check-in (`add to flowList DB`) | Sweep requires `checked_in_at`, fires off `ends_at` |
| Timer = tour + 2.5h | `review_ask_delay_hours`, default 3, measured from `ends_at` |
| Skip if checked in >6h after the tour | **Not ported.** `review_ask_lookback_hours` already bounds the reach |
| Uncheck deletes the timers (`checked == false`) | DB trigger `cancel_review_funnel` |
| Sending the ask schedules `rateAsk2` at +24h | Re-ask pass, keyed off the ask being **sent** |
| `rateAsk2` reminder text | `REVIEW_COPY.reask` |
| Any inbound cancels pending timers | `cancelPendingReviewSends` on every reply |
| Branch only if last outbound was `rateAsk`/`rateAsk2` | `lastOutboundTag` guard |
| 5 -> Google link, 1-4 -> private | `handleInboundReviewReply` |
| Unreadable reply -> notify staff | **Not ported.** Recorded as the comment, nothing sent. It is already in the Messages inbox |
| Link click cancels everything (`stopTask`) | `/r/[token]` cancels + stamps `clicked_link` |
| Runs for one company only | Any business with `google_review_url` set |
| `reviewHelp` AI-written review | Not ported. Disabled in Xano too. |

There are exactly **two** outbound touches per guest before they reply: the ask
and, only if they stayed silent, the re-ask. A "you never opened the link"
nudge was built and then deliberately removed (`20260721143000`): the funnel
stops once someone has answered.

Two places Xano is looser and we are stricter, on purpose: the 1-4 follow-up
reply is **saved as the comment** (Xano drops it), and the re-ask clock starts
when the ask was actually delivered, not when it was queued.

## Why it must stay off

`automations_enabled` is **already true** in production (it drives booking
confirmations), so this funnel does NOT ride on it. Two ways it would
double-text today:

1. **Outbound.** Xano still runs its own rateAsk campaign for Xano-synced
   bookings. The sweep only considers `legacy_id IS NULL`.
2. **Inbound.** `api/webhooks/twilio/sms/route.ts` still mirrors every inbound
   message to Xano, whose fn 269 also branches on rateAsk replies.

## The five brakes

1. `review_automation_enabled` (default **false**).
2. `legacy_id IS NULL` - never touches the ~90k Xano-synced bookings.
3. `review_ask_lookback_hours` (48) - bounded window, so switching on can never
   back-text every booking in history.
4. `checked_in_at IS NOT NULL`, so no-shows are never asked. Check-in is real:
   92% of past bookings have it set (29,265 of 31,818 over 180 days).
5. The business must have `google_review_url` set. None do yet.

Plus the global `sms_hourly_cap`, since every send goes through
`scheduled_messages` and the normal dispatcher. Nothing here calls Twilio.

## The pieces

| Piece | Where |
| --- | --- |
| Schema, kill switch, RLS | `migrations/20260721120000_review_automation.sql` |
| Fixed-flow rework | `migrations/20260721130000_review_funnel_rules.sql` |
| Uncheck / cancel trigger | `migrations/20260721135000_review_cancel_on_uncheck.sql` |
| Ask delay knob | `migrations/20260721136000_review_ask_delay_setting.sql` |
| Link nudge added then removed | `migrations/20260721142000` + `20260721143000` |
| Ask + re-ask sweep | `supabase/functions/enqueue-review-asks/index.ts` |
| Reply classifier | `src/lib/reviews/classify.ts` |
| Replies + cancellation | `src/lib/reviews/funnel.ts` |
| The four messages | `src/lib/reviews/copy.ts` |
| Inbound hook | `src/app/api/webhooks/twilio/sms/route.ts` |
| Tracked link | `src/app/r/[token]/route.ts` |
| Read-only card | `admin/messaging/review-funnel-card.tsx` |

`reviews` holds one row per asked booking: rating, comment, and the
ask/re-ask/link/cancel state. `source` leaves room to import Google reviews
later. Writes are service-role only; owners see all, managers see their own.

### The classifier

Deterministic parse first (`"5"`, `"5/5"`, `"5 stars"`, `"five"`), so the common
case costs nothing. Only chattier replies hit Groq, matching the
deterministic-then-model shape of `gp-voucher-vision`. Without `GROQ_API_KEY`
the fallback is skipped and non-numeric replies alert staff instead, which is
safe. Xano sent every reply to gpt-4o-mini.

## Go-live checklist

- [x] Migrations applied; `enqueue-review-asks` deployed (JWT off, cron-secret
      auth), verified returning `skipped` through the real cron path.
- [x] Uncheck trigger verified: cancels the review and flips queued sends to
      `canceled` (tested in a rolled-back transaction).
- [ ] Set `GROQ_API_KEY` on the Next app (optional but recommended).
- [ ] Set `NEXT_PUBLIC_APP_URL` so `/r/<token>` links resolve.
- [ ] Set `google_review_url` on each business that should ask.
- [ ] **Schedule the cron** (not scheduled on purpose, SQL below).
- [ ] **Stop Xano handling these replies**: `XANO_SMS_FORWARD_URL=""` and
      disable Xano's rateAsk campaign.
- [ ] Flip the switch on the card at `/admin/messaging`.
- [ ] Smoke-test the enabled path end to end. Only the disabled path has been
      exercised so far.

Consider dropping `review_ask_lookback_hours` for the first run, since it will
pick up everything inside the window at once.

### Cron (deliberately not scheduled yet)

```sql
select cron.schedule(
  'enqueue-review-asks',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/enqueue-review-asks',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
```

## Known gaps

- **No reviews UI.** `reviews` is written but nothing reads it. A `/reviews`
  section (ratings, complaints, replies, Google import) is the other half of
  the Xano feature and was intentionally left out.
- **Reply matching is per customer, not per booking.** Someone with two recent
  tours has their reply attributed to the most recent open ask.
- **Effectively dormant for now.** Only Supabase-native bookings qualify, and
  there is currently ~1 of those, so nothing will flow until booking writers
  move off Xano.
