-- Non-US phone trigger: "when a booking comes in from an overseas number".
--
-- About a fifth of the customer book is not US (roughly 20k of 91k rows), and
-- none of them have ever been reachable: the automation runner normalized every
-- phone with a US-only helper, so an overseas number resolved to NULL and the
-- run stopped at "no customer phone" before a single rule was read. Those guests
-- get no confirmation, no ticket link, nothing.
--
-- This adds a SECOND trigger event rather than a condition on the existing one,
-- because an international guest usually needs a different message, not the same
-- one: WhatsApp instead of SMS, no US-shortcode reply instructions, and the
-- owner may want to skip the chattier follow-ups given international SMS pricing.
-- A separate trigger lets the owner write that separately in the same builder.
--
-- The two events are EXCLUSIVE: the runner classifies the booking's phone once
-- and fires exactly one of them. So no guest is ever double-messaged, and
-- new_booking keeps its existing meaning to the letter (it could only ever reach
-- a US number anyway, since the US-only helper filtered the rest out before the
-- rule query). Every automation that exists today keeps behaving identically.

alter table public.messaging_rules
  drop constraint if exists messaging_rules_trigger_event_check;

alter table public.messaging_rules
  add constraint messaging_rules_trigger_event_check
  check (trigger_event in ('new_booking', 'new_booking_non_us'));

comment on column public.messaging_rules.trigger_event is
  'What starts the automation. new_booking = a booking from a US (+1) phone; '
  'new_booking_non_us = a booking from an overseas phone. Exactly one fires per '
  'booking, decided by run-booking-automations from the customer phone.';
