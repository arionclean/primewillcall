-- Inbound OTA booking emails: the log, the retry queue and the silence alarm.
--
-- Until now an OTA reservation email reached us through a Make scenario, and Make's
-- execution history was the only place you could see that it arrived, what it parsed
-- to, and whether it failed. Moving the intake to Resend (email.received webhook ->
-- the email-inbound function) removes that screen, and an OTA email is a real
-- person's reservation: losing one silently means a guest shows up to a departure
-- nobody booked them on. So the log is not a nice-to-have, it is the feature.
--
-- Three things this table has to make impossible:
--
--   1. A silent drop. The row is written the moment the webhook lands, BEFORE any
--      parsing, so an email that arrives always leaves a trace even if every step
--      after it fails.
--   2. A one-shot failure. status/attempts drive the email-inbound-sweep cron, which
--      re-runs anything still 'received' or 'failed'. Resend keeps the body, so a
--      retry needs nothing from us but the provider's id.
--   3. A stopped pipeline. Nothing in the rows themselves can report that email has
--      STOPPED arriving (a broken MX record, a deleted forwarding rule). The sweep
--      reads the newest received_at against inbound_email_settings.silence_minutes
--      and alerts. This is the failure Make could not see either.
--
-- Idempotency is (provider, provider_email_id): Resend's webhook retries and our own
-- sweep can both land on the same email and only the first one creates a row.

create table if not exists public.inbound_emails (
  id                uuid primary key default gen_random_uuid(),

  -- Who delivered it and their id for it. Unique together, so every retry path
  -- (Svix redelivery, our sweep, a manual replay) converges on the one row.
  provider          text not null default 'resend',
  provider_email_id text not null,

  received_at       timestamptz not null default now(),
  from_address      text,
  to_addresses      text[] not null default '{}',
  subject           text,

  -- The plain-text body, fetched from the provider on the first processing pass and
  -- kept: it is what the parser saw, so a wrong booking can be explained later
  -- without asking Resend for an email it may no longer hold.
  raw_text          text,

  -- The Bubble company id the email was addressed to (which business), resolved from
  -- the recipients the same way the Make scenario did.
  legacy_company_id text,

  -- received: recorded, not yet processed (or a pass failed part way and will retry).
  -- parsed:   read fine, but it was not a reservation (a bounce, a newsletter, a
  --           report). Nothing to book, and deliberately NOT a failure, so the junk
  --           that reaches any inbox cannot bury the one alarm that matters.
  -- booked:   a booking exists. The happy path.
  -- failed:   out of attempts. Someone has to look.
  -- ignored:  deliberately set aside by hand (bounce, spam, a test).
  status            text not null default 'received'
                      check (status in ('received', 'parsed', 'booked', 'failed', 'ignored')),
  attempts          int  not null default 0,
  last_attempt_at   timestamptz,
  error             text,

  -- What came of it, for the screen: the booking, the product it landed on, and the
  -- email_match_queue row when a human has to choose the product.
  booking_id        uuid references public.bookings(id) on delete set null,
  business_tour_id  uuid references public.business_tours(id) on delete set null,
  match_queue_id    uuid,

  -- Stamped when this row's failure was alerted, so one bad email alerts once.
  alert_sent_at     timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (provider, provider_email_id)
);

comment on table public.inbound_emails is
  'One row per inbound OTA booking email. The intake log, the retry queue and the '
  'evidence behind every booking born from an email. Written by email-inbound.';

-- The sweep asks for "unfinished, oldest first"; the screen asks for "newest first".
create index if not exists inbound_emails_pending_idx
  on public.inbound_emails (received_at)
  where status in ('received', 'failed');

create index if not exists inbound_emails_recent_idx
  on public.inbound_emails (received_at desc);

drop trigger if exists inbound_emails_set_updated_at on public.inbound_emails;
create trigger inbound_emails_set_updated_at
  before update on public.inbound_emails
  for each row execute function public.set_updated_at();

-- ── settings ─────────────────────────────────────────────────────────────────
-- One row. Knobs the owner may need at 6am without a deploy.

create table if not exists public.inbound_email_settings (
  id                    boolean primary key default true check (id),

  -- Master switch for BOTH alarms (a failed email, and no email at all).
  alerts_enabled        boolean not null default true,

  -- How long a gap with no email at all counts as the pipeline being broken.
  -- OTA volume is steady through the day, so three hours of nothing in business
  -- hours is already abnormal.
  silence_minutes       int not null default 180,

  -- The New York hours the silence alarm sleeps through, because overnight quiet is
  -- normal and an alarm that cries at 4am gets muted, which defeats it. Inclusive of
  -- quiet_from_hour, exclusive of quiet_to_hour.
  quiet_from_hour       int not null default 22 check (quiet_from_hour between 0 and 23),
  quiet_to_hour         int not null default 8  check (quiet_to_hour   between 0 and 23),

  -- Processing passes before a row is given up on and alerted.
  max_attempts          int not null default 5 check (max_attempts between 1 and 20),

  -- Set by the sweep. Stops the silence alarm repeating every five minutes.
  last_silence_alert_at timestamptz,

  updated_at            timestamptz not null default now()
);

insert into public.inbound_email_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists inbound_email_settings_set_updated_at on public.inbound_email_settings;
create trigger inbound_email_settings_set_updated_at
  before update on public.inbound_email_settings
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Owner reads, nobody writes. Every write comes from an edge function on the
-- service role, which bypasses RLS: there is no path for a signed-in staff member
-- to alter the intake record, which is the point of keeping one.

alter table public.inbound_emails         enable row level security;
alter table public.inbound_email_settings enable row level security;

drop policy if exists inbound_emails_owner_select on public.inbound_emails;
create policy inbound_emails_owner_select
  on public.inbound_emails for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

drop policy if exists inbound_email_settings_owner_select on public.inbound_email_settings;
create policy inbound_email_settings_owner_select
  on public.inbound_email_settings for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

drop policy if exists inbound_email_settings_owner_update on public.inbound_email_settings;
create policy inbound_email_settings_owner_update
  on public.inbound_email_settings for update to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- ── realtime ─────────────────────────────────────────────────────────────────
-- /admin/inbound watches this: an email that arrives while the owner is on the
-- screen should appear without a reload. No subscriber filters on a column, so
-- the default replica identity is enough.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inbound_emails'
  ) then
    alter publication supabase_realtime add table public.inbound_emails;
  end if;
end $$;

-- ── the sweep ────────────────────────────────────────────────────────────────
-- Retries what is unfinished and raises the silence alarm. Five minutes is the
-- gap between an OTA email failing and a human hearing about it, which is well
-- inside the time it takes anyone to act on a booking.
--
-- The silence alarm only ever fires once at least one email has EVER arrived, so
-- this is inert until the Resend webhook is actually pointed here.

select cron.schedule(
  'email-inbound-sweep',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/email-inbound-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 25000
    );
  $$
);
