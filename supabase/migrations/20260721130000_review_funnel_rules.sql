-- Review funnel, second pass: port the Xano rules that the first cut missed.
--
-- The first cut modelled the ask as an ordinary editable automation. That was
-- wrong on two counts: staff will never author another funnel like this, and
-- the real behaviour lives in rules a messaging_rule cannot express (branching
-- on the reply, cancelling on uncheck, a re-ask that only fires when nobody
-- answered). So the funnel becomes a fixed state machine and stops being a row
-- in messaging_rules.
--
-- Rules recovered from Xano (task 9 "execute timers", fn 94 "add to flowList
-- DB", fn 101 "stopTask", fn 269 "analyze inbound message_v2"):
--
--   * the ask is scheduled off CHECK-IN, and unchecking cancels it
--   * a check-in that lands long after the tour is skipped, not back-texted
--   * sending the ask schedules a 24h re-ask; a lot of people only answer that
--   * ANY reply cancels the pending re-ask
--   * clicking the review link cancels everything still pending
--   * a reply only counts as a rating if the last thing we sent was the ask
--
-- Everything still gated by messaging_settings.review_automation_enabled.

-- ---------------------------------------------------------------------------
-- 1. The funnel is not an automation any more.
-- ---------------------------------------------------------------------------

-- Remove the editable rule created earlier. The copy now lives in
-- src/lib/reviews/copy.ts and the steps are fixed.
delete from public.messaging_rules where trigger_event = 'after_tour';

-- ...and put the trigger whitelist back to what the engine really supports.
alter table public.messaging_rules
  drop constraint if exists messaging_rules_trigger_event_check;
alter table public.messaging_rules
  add constraint messaging_rules_trigger_event_check
  check (trigger_event = 'new_booking');

-- ---------------------------------------------------------------------------
-- 2. Funnel state on reviews.
-- ---------------------------------------------------------------------------

-- The old column tracked "5-star customer never clicked the link". That is
-- Xano's `reviewHelp` branch, which is DISABLED there. The follow-up that
-- actually earns replies is the re-ask to people who never answered at all.
alter table public.reviews
  rename column reminder_sent_at to reask_sent_at;

comment on column public.reviews.reask_sent_at is
  'When the 24h "in case you missed it" re-ask was queued. Xano rateAsk2, the follow-up most replies come from.';

alter table public.reviews
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text
    check (cancel_reason is null or cancel_reason in ('unchecked', 'replied', 'clicked_link'));

comment on column public.reviews.cancelled_at is
  'Funnel stopped early. Nothing further is queued for this booking.';
comment on column public.reviews.cancel_reason is
  'unchecked = the booking was un-checked-in, replied = the guest answered, clicked_link = they opened the review link.';

-- The re-ask sweep looks for asked-but-unanswered rows still in play.
create index if not exists reviews_awaiting_reply_idx
  on public.reviews (asked_at)
  where rating is null and cancelled_at is null and reask_sent_at is null;

-- Cancelling means finding this customer's or booking's queued review sends.
create index if not exists scheduled_messages_pending_phone_idx
  on public.scheduled_messages (to_phone)
  where status = 'pending';

create index if not exists scheduled_messages_pending_booking_idx
  on public.scheduled_messages (booking_id)
  where status = 'pending';

-- Finding "was the ask actually delivered, and when" for the re-ask pass, and
-- "what did we last send this number" for the rating check.
create index if not exists scheduled_messages_sent_tag_idx
  on public.scheduled_messages (tag, sent_at)
  where status = 'sent';
