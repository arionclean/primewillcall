-- The Mailroom: what each step did, one alert per problem, and a way back in.
--
-- The OTA email intake (inbound_emails, email-inbound, email-inbound-sweep) gets its
-- name and the parts of Make's observability it was missing on 2026-09-23, the day
-- Make was switched off:
--
--   1. steps. A pass records what each step did (fetch, read, book), how long it took,
--      and which one broke. Make showed every module's input and output; this is that,
--      kept for good instead of for a plan's retention window.
--   2. warnings. The details a read could not find on a booking it still made, as
--      codes (no_guest_count, guest_count_mismatch, no_guest_name, no_channel). Make
--      refused to book those and pushed an alert; the Mailroom books what it can and
--      says so. Only a wrong head count texts the owner (it breaks the manifest and
--      capacity); a missing name or channel shows on the screen only, since the name
--      alone misses on about one email in ten and an alarm that noisy gets muted.
--   3. 'failed' now means a person owns it. The sweep retries only 'received' rows.
--      A row that runs out of attempts, or that looks like a booking but reads as
--      nothing, goes to 'failed' and stays there until someone presses Retry
--      (mailroom_retry) or Set aside (mailroom_set_aside).
--   4. One alert per problem, from one place. mailroom_claim_alerts stamps
--      alert_sent_at on every row that needs telling, before anything is sent, so no
--      two sweep runs can report the same email.
--   5. mailroom_claim_pending hands the sweep its retries under FOR UPDATE SKIP
--      LOCKED, so a Retry-button run and a scheduled run never work one email twice.
--
-- The screen (/admin/mailroom) is an internal tool: owner only, and linked from
-- nowhere in the app. The alerts carry the link.

alter table public.inbound_emails
  add column if not exists steps      jsonb  not null default '[]'::jsonb,
  add column if not exists warnings   text[] not null default '{}',
  add column if not exists ignored_at timestamptz,
  add column if not exists ignored_by uuid references public.staff(id) on delete set null;

comment on column public.inbound_emails.steps is
  'What the latest pass did, in order: [{step: fetch|read|book, ok, at, ms, note, data}]. '
  'Kept when a pass fails, so the screen shows which step broke and what it had read.';
comment on column public.inbound_emails.warnings is
  'Codes for details the read could not find on a booking it still made: '
  'no_guest_count, guest_count_mismatch (both alerted once, through '
  'mailroom_claim_alerts), no_guest_name, no_channel (screen only).';
comment on column public.inbound_emails.alert_sent_at is
  'Stamped when a person was told about this row (a failure, or a booking made with '
  'warnings). Claimed before sending, released if nothing could be sent.';
comment on column public.inbound_emails.status is
  'received: not finished, the sweep retries it. parsed: read fine, not a reservation. '
  'booked: a booking exists. failed: a person owns it (out of attempts, or it looks like '
  'a booking but reads as nothing); only Retry sends it round again. ignored: set aside '
  'by hand (ignored_at, ignored_by).';

-- ── the sweep's claims (service role only) ──────────────────────────────────────

create or replace function public.mailroom_claim_pending(
  p_limit int,
  p_max_attempts int,
  p_retry_after_minutes int
)
returns table (
  id uuid,
  provider_email_id text,
  subject text,
  raw_text text,
  to_addresses text[],
  legacy_company_id text,
  attempts int,
  received_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  update public.inbound_emails e
     set last_attempt_at = now()
   where e.id in (
     select i.id
       from public.inbound_emails i
      where i.status = 'received'
        and i.attempts < p_max_attempts
        and (
          i.last_attempt_at is null
          or i.last_attempt_at < now() - make_interval(mins => p_retry_after_minutes)
        )
      order by i.received_at
      limit p_limit
      for update skip locked
   )
  returning e.id, e.provider_email_id, e.subject, e.raw_text, e.to_addresses,
            e.legacy_company_id, e.attempts, e.received_at;
$$;

comment on function public.mailroom_claim_pending(int, int, int) is
  'The Mailroom sweep''s retries: unfinished rows past their retry delay, oldest first, '
  'claimed by stamping last_attempt_at under FOR UPDATE SKIP LOCKED.';

create or replace function public.mailroom_claim_alerts()
returns table (
  id uuid,
  status text,
  subject text,
  error text,
  warnings text[],
  received_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  update public.inbound_emails e
     set alert_sent_at = now()
   where e.alert_sent_at is null
     and (
       e.status = 'failed'
       -- Same list as ALERT_WARNINGS in _shared/inbound-email.ts.
       or (e.status = 'booked'
           and e.warnings && array['no_guest_count', 'guest_count_mismatch'])
     )
  returning e.id, e.status, e.subject, e.error, e.warnings, e.received_at;
$$;

comment on function public.mailroom_claim_alerts() is
  'Every Mailroom row a person has not been told about yet (failed, or booked with a '
  'wrong head count), stamped alert_sent_at in the same statement so it is reported once.';

revoke all on function public.mailroom_claim_pending(int, int, int) from public, anon, authenticated;
revoke all on function public.mailroom_claim_alerts() from public, anon, authenticated;
grant execute on function public.mailroom_claim_pending(int, int, int) to service_role;
grant execute on function public.mailroom_claim_alerts() to service_role;

-- ── the screen (owner only) ────────────────────────────────────────────────────

-- The health line, counted over the whole log rather than the rows on screen.
-- SECURITY INVOKER: inbound_emails RLS already limits it to the owner.
create or replace function public.mailroom_summary()
returns table (
  last_received_at timestamptz,
  failed bigint,
  working bigint,
  booked_today bigint,
  warnings_week bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    max(e.received_at),
    count(*) filter (where e.status = 'failed'),
    count(*) filter (where e.status = 'received'),
    count(*) filter (
      where e.status = 'booked'
        and e.received_at >= (date_trunc('day', now() at time zone 'America/New_York')
                              at time zone 'America/New_York')
    ),
    count(*) filter (
      where e.status = 'booked'
        and cardinality(e.warnings) > 0
        and e.received_at > now() - interval '7 days'
    )
  from public.inbound_emails e;
$$;

-- Send an email round again: back to 'received' with a fresh set of attempts, and a
-- sweep run kicked now so the owner sees the result in seconds, not in five minutes.
-- The evidence (the email, when it came, who sent it) is never touched: only the
-- processing state is, which is why this is a function and not an UPDATE policy.
create or replace function public.mailroom_retry(p_email_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_secret text;
begin
  if not exists (select 1 from public.current_staff() cs where cs.role = 'owner') then
    raise exception 'Only the owner can retry a Mailroom email' using errcode = '42501';
  end if;

  update public.inbound_emails
     set status = 'received',
         attempts = 0,
         error = null,
         alert_sent_at = null,
         last_attempt_at = null,
         ignored_at = null,
         ignored_by = null
   where id = p_email_id
     and status in ('failed', 'parsed', 'ignored', 'received')
  returning status into v_status;

  if v_status is null then
    raise exception 'This email cannot be retried' using errcode = 'P0001';
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'dispatch_cron_secret';
  if v_secret is not null then
    perform net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/email-inbound-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := jsonb_build_object('reason', 'retry'),
      timeout_milliseconds := 25000
    );
  end if;

  return v_status;
end;
$$;

-- Take an email off the Mailroom's hands: junk that looked like a booking, a failure
-- already booked by hand. Recorded with who and when.
create or replace function public.mailroom_set_aside(p_email_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid;
  v_status text;
begin
  select cs.staff_id into v_staff
    from public.current_staff() cs
   where cs.role = 'owner';
  if v_staff is null then
    raise exception 'Only the owner can set a Mailroom email aside' using errcode = '42501';
  end if;

  update public.inbound_emails
     set status = 'ignored',
         ignored_at = now(),
         ignored_by = v_staff
   where id = p_email_id
     and status in ('failed', 'parsed', 'received')
  returning status into v_status;

  if v_status is null then
    raise exception 'This email cannot be set aside' using errcode = 'P0001';
  end if;

  return v_status;
end;
$$;

revoke all on function public.mailroom_summary() from public, anon;
revoke all on function public.mailroom_retry(uuid) from public, anon;
revoke all on function public.mailroom_set_aside(uuid) from public, anon;
grant execute on function public.mailroom_summary() to authenticated;
grant execute on function public.mailroom_retry(uuid) to authenticated;
grant execute on function public.mailroom_set_aside(uuid) to authenticated;
