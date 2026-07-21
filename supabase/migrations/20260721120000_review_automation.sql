-- Review automation: the post-tour "rate us 1-5" funnel.
--
-- Ported from Xano's rateAsk flow (fn 269 "analyze inbound message_v2"), but
-- rebuilt on the queue this app already has instead of Xano's timer table:
--
--   3h after the tour ends -> SMS "How was it? Reply 1-5"
--   reply of 5             -> store the rating, text the Google review link,
--                             then nudge once at 24h if the link is never clicked
--   reply of 1-4           -> store the rating, ask privately what went wrong.
--                             Low scores are deliberately kept off Google.
--
-- SAFETY. This ships INERT and must stay that way until Xano stops.
-- messaging_settings.automations_enabled is ALREADY true in production (it
-- drives booking confirmations), so the review funnel deliberately does NOT
-- ride on it. It gets its own switch, review_automation_enabled, default false.
-- Two ways this would double-text customers if it were on today:
--   1. Xano still runs its own rateAsk campaign for Xano-synced bookings, so
--      the sweep only ever considers bookings with legacy_id IS NULL.
--   2. The inbound webhook still mirrors every reply to Xano, whose fn 269
--      also branches on rateAsk replies.
-- See docs/messaging-automations.md for the go-live order.

-- ---------------------------------------------------------------------------
-- 1. Settings: the kill switch plus the timing knobs, tunable without a deploy.
-- ---------------------------------------------------------------------------

-- How long after the tour the ask waits is deliberately NOT here: it is the
-- automation's own wait (messaging_rules.delay_minutes), so it stays visible
-- and editable in /admin/messaging instead of being a hidden offset.
alter table public.messaging_settings
  add column if not exists review_automation_enabled boolean not null default false,
  add column if not exists review_ask_lookback_hours integer not null default 48,
  add column if not exists review_reminder_hours integer not null default 24;

comment on column public.messaging_settings.review_automation_enabled is
  'Master switch for the post-tour review funnel. Separate from automations_enabled on purpose: booking confirmations are already live, the review funnel is not.';
comment on column public.messaging_settings.review_ask_lookback_hours is
  'How far back the sweep will look for un-asked bookings. This is the backstop that stops the first run from texting every past booking at once. Keep it small.';
comment on column public.messaging_settings.review_reminder_hours is
  'How long to wait after sending the Google link before the single reminder.';

-- Guardrails: a lookback of days, not months, and a reminder that cannot spam.
alter table public.messaging_settings
  drop constraint if exists messaging_settings_review_windows_check;
alter table public.messaging_settings
  add constraint messaging_settings_review_windows_check
  check (
    review_ask_lookback_hours between 1 and 168
    and review_reminder_hours between 1 and 168
  );

-- ---------------------------------------------------------------------------
-- 2. Where a happy customer gets sent. No URL means that business never asks.
-- ---------------------------------------------------------------------------

alter table public.businesses
  add column if not exists google_review_url text;

comment on column public.businesses.google_review_url is
  'Google "write a review" link for this business. The review funnel skips any business that does not have one set.';

-- ---------------------------------------------------------------------------
-- 3. Let the engine accept the new trigger. The whitelist only knew about
--    new_booking, so an after_tour rule was rejected at insert time.
-- ---------------------------------------------------------------------------

alter table public.messaging_rules
  drop constraint if exists messaging_rules_trigger_event_check;
alter table public.messaging_rules
  add constraint messaging_rules_trigger_event_check
  check (trigger_event in ('new_booking', 'after_tour'));

-- ---------------------------------------------------------------------------
-- 4. reviews: one row per booking we asked, holding both the funnel state and
--    the rating itself. Deliberately one table, not a request/review split:
--    there is no reviews UI yet, and `source` leaves room to import Google
--    reviews alongside these later without a second table.
-- ---------------------------------------------------------------------------

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- set null, not cascade: a deleted booking should not erase the rating.
  booking_id uuid references public.bookings(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,

  -- Powers /r/<token>, which stamps link_clicked_at then forwards to Google.
  -- Reuses the existing generic short-token generator (its name is historical).
  token text not null default public.generate_booking_token(),

  rating smallint check (rating between 1 and 5),
  comment text,
  source text not null default 'sms' check (source in ('sms', 'google')),

  asked_at timestamptz,
  responded_at timestamptz,
  link_sent_at timestamptz,
  link_clicked_at timestamptz,
  reminder_sent_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists reviews_token_key on public.reviews (token);

-- Idempotency: a booking is only ever asked once. Partial so imported Google
-- reviews (no booking) are unconstrained.
create unique index if not exists reviews_booking_id_key
  on public.reviews (booking_id)
  where booking_id is not null;

create index if not exists reviews_business_created_idx
  on public.reviews (business_id, created_at desc);

-- The reminder sweep: 5-star rows that were sent a link, never clicked it and
-- have not been nudged yet.
create index if not exists reviews_pending_reminder_idx
  on public.reviews (link_sent_at)
  where link_clicked_at is null and reminder_sent_at is null and link_sent_at is not null;

drop trigger if exists set_reviews_updated_at on public.reviews;
create trigger set_reviews_updated_at
before update on public.reviews
for each row
execute function public.set_updated_at();

-- The ask sweep scans native bookings by when they ended. Partial index keeps
-- it off the ~90k Xano-synced rows, which this funnel never touches.
create index if not exists bookings_native_ends_at_idx
  on public.bookings (ends_at)
  where legacy_id is null;

-- ---------------------------------------------------------------------------
-- 5. RLS. Reads are scoped the usual way; every write goes through the service
--    role (the sweep edge function and the inbound webhook), so there is no
--    write policy on purpose. Same shape as scheduled_messages.
-- ---------------------------------------------------------------------------

alter table public.reviews enable row level security;

drop policy if exists "reviews_select" on public.reviews;
create policy "reviews_select"
on public.reviews
for select
to authenticated
using (
  exists (
    select 1
    from current_staff() cs(staff_id, role, business_id)
    where cs.role = 'owner'::staff_role
       or (cs.role = 'business_manager'::staff_role and cs.business_id = public.reviews.business_id)
  )
);

comment on table public.reviews is
  'Post-tour review funnel: one row per asked booking, holding the rating and the ask/link/reminder state. Written only by the service role.';
