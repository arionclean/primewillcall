-- Put the ask delay back on settings.
--
-- It was removed in 20260721120000 because at the time the ask was a
-- messaging_rules row and its delay_minutes already carried the wait, so two
-- knobs would have stacked. The funnel is now a fixed flow with no rule, so
-- this is the single source of truth for "how long after the tour we ask".
--
-- Both timings live in the database rather than in code so they can be tuned
-- without a deploy. They are NOT staff-editable: /admin/messaging shows the
-- funnel read-only.
alter table public.messaging_settings
  add column if not exists review_ask_delay_hours integer not null default 3;

comment on column public.messaging_settings.review_ask_delay_hours is
  'Hours after a tour ends before the 1-5 ask is sent. Xano used 2.5h measured from the tour start.';

alter table public.messaging_settings
  drop constraint if exists messaging_settings_review_windows_check;
alter table public.messaging_settings
  add constraint messaging_settings_review_windows_check
  check (
    review_ask_delay_hours between 0 and 168
    and review_ask_lookback_hours between 1 and 168
    and review_reminder_hours between 1 and 168
  );

comment on column public.messaging_settings.review_reminder_hours is
  'Hours after the ask was delivered before the single re-ask goes to people who never replied. Xano rateAsk2, 24h.';
