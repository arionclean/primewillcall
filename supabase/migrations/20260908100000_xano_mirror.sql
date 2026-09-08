-- Xano mirror: every booking change made in this app is copied into Xano.
--
-- Why. Staff are moving to this app while the iPads (and the rollback path) still
-- read Xano. A booking created, edited, checked in or voided here must therefore
-- reach Xano too, or the tablet never sees the guest and a rollback loses the change.
-- The other direction already exists: Xano's "New Supabase platfomr" trigger posts
-- every row into xano-booking-sync.
--
-- How. An AFTER trigger on bookings writes a row into xano_mirror_queue (the outbox).
-- Nothing calls Xano from inside the transaction. Every minute pg_cron runs the
-- xano-mirror-dispatch edge function, which claims due rows, reads the booking's
-- CURRENT state and sends it (create through booking/v12, everything else through
-- the partial PATCH the iPad already uses), retrying with backoff when Xano is down.
-- One pending row per booking: a burst of edits collapses into one send.
--
-- The loop. Xano echoes what it receives back through xano-booking-sync. Two brakes:
--   1. Origin. The sync (and the ghost script) send the request header
--      `x-sync-origin: xano`; functions that mirror on their own (the kiosk sale flow,
--      the worker itself) send `x-sync-origin: mirror`. The trigger reads the header
--      through PostgREST's request.headers and enqueues nothing for those writes.
--   2. Identity. The booking's Xano internal id is stored in bookings.xano_internal_id
--      before Xano is called, so the echo is matched to the row that caused it (the
--      sync looks that column up first) and, for a booking born here, applies only
--      the two flags staff toggle on the Xano side: the iPad check-in and Peek.
--
-- Who is mirrored. INSERT: only a booking born here (legacy_id null) that no other
-- mirror owns: Groupon bookings are created in Xano by gp-xano-mirror after payment,
-- kiosk sales by the kiosk sale flow. UPDATE: any booking that has a Xano row we can
-- address (a Xano id, an internal id, or a legacy_id to look one up by), when one of
-- the mirrored fields changed: time, product, status, pax, check-in, note.
--
-- Switch: xano_mirror_settings.enabled (default OFF). Off, the trigger enqueues
-- nothing and the worker sends nothing. See docs/xano-mirror.md.

-- ── bookings: where the row lives in Xano ────────────────────────────────────

alter table public.bookings
  add column if not exists xano_internal_id text,
  add column if not exists xano_booking_id  bigint;

comment on column public.bookings.xano_internal_id is
  'Xano bookings.internal_id for this booking. Set by xano-booking-sync from the echo, by the mirrors before they call Xano (a GP- or SB- reference we minted). booking/v12 adds or edits by it, so the key Xano''s echo is matched on.';
comment on column public.bookings.xano_booking_id is
  'Xano bookings.id (the numeric row id). What the PATCH endpoint the iPad uses addresses a booking by. Learned from the echo or from the create response.';

create index if not exists bookings_xano_internal_id_idx
  on public.bookings (xano_internal_id)
  where xano_internal_id is not null;

-- Groupon bookings already mirrored carry their Xano internal id inside legacy_id
-- ('ota-GP-<ref>', the reference gp-xano-mirror chose). Copy it out so an edit to
-- one of them can be addressed.
update public.bookings
   set xano_internal_id = substr(legacy_id, 5)
 where legacy_id like 'ota-GP-%'
   and xano_internal_id is null;

-- ── the switch ───────────────────────────────────────────────────────────────

create table if not exists public.xano_mirror_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.xano_mirror_settings is
  'Single row. enabled = copy booking changes made here into Xano (docs/xano-mirror.md). Off by default; flip it once the xano-mirror-dispatch function is deployed.';

insert into public.xano_mirror_settings (id, enabled)
values (true, false)
on conflict (id) do nothing;

alter table public.xano_mirror_settings enable row level security;

drop policy if exists xano_mirror_settings_owner_select on public.xano_mirror_settings;
create policy xano_mirror_settings_owner_select
  on public.xano_mirror_settings for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

drop policy if exists xano_mirror_settings_owner_update on public.xano_mirror_settings;
create policy xano_mirror_settings_owner_update
  on public.xano_mirror_settings for update to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- ── the queue (outbox) ───────────────────────────────────────────────────────

create table if not exists public.xano_mirror_queue (
  id              bigint generated always as identity primary key,
  booking_id      uuid not null references public.bookings(id) on delete cascade,
  -- create: the booking does not exist in Xano yet. update: it does; send the changes.
  op              text not null check (op in ('create', 'update')),
  -- Which mirrored fields changed since the row was queued (merged across edits).
  fields          text[] not null default '{}',
  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz
);

comment on table public.xano_mirror_queue is
  'Outbox of booking changes waiting to be copied into Xano. Written by the enqueue_xano_mirror trigger, drained every minute by the xano-mirror-dispatch edge function. failed = gave up (the error says why); the dashboard shows the owner both counts.';

-- One pending row per booking: a later edit merges into it, and the worker sends
-- the booking's current state anyway.
create unique index if not exists xano_mirror_queue_one_pending
  on public.xano_mirror_queue (booking_id)
  where status = 'pending';

create index if not exists xano_mirror_queue_due_idx
  on public.xano_mirror_queue (next_attempt_at)
  where status = 'pending';

create index if not exists xano_mirror_queue_booking_idx
  on public.xano_mirror_queue (booking_id);

alter table public.xano_mirror_queue enable row level security;

-- The owner can see the queue (the dashboard counts it). Nobody writes through the
-- API: the trigger is SECURITY DEFINER and the worker runs as the service role.
drop policy if exists xano_mirror_queue_owner_select on public.xano_mirror_queue;
create policy xano_mirror_queue_owner_select
  on public.xano_mirror_queue for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- ── where a write came from ──────────────────────────────────────────────────

-- The x-sync-origin request header, or '' when there is none (a direct connection,
-- a migration, cron SQL). PostgREST exposes request headers as a JSON GUC; the same
-- mechanism carries x-employee-id (web_activity_log).
create or replace function public.xano_mirror_origin()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  raw text;
begin
  raw := current_setting('request.headers', true);
  if raw is null or raw = '' then
    return '';
  end if;
  return coalesce(raw::json ->> 'x-sync-origin', '');
exception when others then
  return '';
end;
$$;

-- ── the enqueue trigger ──────────────────────────────────────────────────────

-- The distinct union of two text arrays (the fields of a merged queue row).
create or replace function public.text_array_union(a text[], b text[])
returns text[]
language sql
immutable
as $$
  select coalesce(array(select distinct x from unnest(coalesce(a, '{}') || coalesce(b, '{}')) as x), '{}');
$$;

create or replace function public.enqueue_xano_mirror()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fields text[] := '{}';
  v_op     text;
begin
  -- 1. A write that came from Xano (the sync's echo, the ghost script) or from code
  --    that mirrors on its own (the kiosk sale flow, the worker) never goes back.
  if public.xano_mirror_origin() in ('xano', 'mirror') then
    return null;
  end if;

  -- 2. The switch.
  if not exists (select 1 from public.xano_mirror_settings where id and enabled) then
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- Only a booking born here that no other mirror owns.
    if new.legacy_id is not null then return null; end if;          -- came through the sync
    if new.source_channel = 'groupon' then return null; end if;     -- gp-xano-mirror, after payment
    if new.awaiting_payment then return null; end if;                -- hidden from staff too
    v_op := 'create';
  else
    if new.starts_at is distinct from old.starts_at then
      v_fields := array_append(v_fields, 'starts_at');
    end if;
    if new.business_tour_id is distinct from old.business_tour_id then
      v_fields := array_append(v_fields, 'business_tour_id');
    end if;
    if new.status is distinct from old.status then
      v_fields := array_append(v_fields, 'status');
    end if;
    if new.pax_adult is distinct from old.pax_adult
       or new.pax_child is distinct from old.pax_child
       or new.pax_infant is distinct from old.pax_infant then
      v_fields := array_append(v_fields, 'pax');
    end if;
    if new.checked_in_at is distinct from old.checked_in_at then
      v_fields := array_append(v_fields, 'checked_in_at');
    end if;
    if new.notes is distinct from old.notes then
      v_fields := array_append(v_fields, 'notes');
    end if;
    if coalesce(array_length(v_fields, 1), 0) = 0 then return null; end if;

    -- Not in Xano yet: nothing to update. A queued create sends the current state.
    if new.xano_booking_id is null and new.xano_internal_id is null and new.legacy_id is null then
      return null;
    end if;
    if new.awaiting_payment then return null; end if;
    v_op := 'update';
  end if;

  insert into public.xano_mirror_queue as q (booking_id, op, fields)
  values (new.id, v_op, v_fields)
  on conflict (booking_id) where status = 'pending'
  do update set
    fields = public.text_array_union(q.fields, excluded.fields),
    op = case when q.op = 'create' then 'create' else excluded.op end,
    next_attempt_at = least(q.next_attempt_at, now()),
    updated_at = now();

  return null;
end;
$$;

drop trigger if exists trg_xano_mirror_enqueue on public.bookings;
create trigger trg_xano_mirror_enqueue
  after insert or update on public.bookings
  for each row
  execute function public.enqueue_xano_mirror();

-- ── the worker's claim ───────────────────────────────────────────────────────

-- Same shape as claim_due_scheduled_messages. A row stuck in 'sending' (the worker
-- died mid-send) goes back to pending after ten minutes; sends are idempotent
-- (booking/v12 adds or edits by internal id, the PATCH sets values), so a repeat
-- is harmless.
create or replace function public.claim_xano_mirror_rows(batch integer default 25)
returns setof public.xano_mirror_queue
language sql
security definer
set search_path = public
as $$
  update public.xano_mirror_queue
     set status = 'pending', updated_at = now()
   where status = 'sending'
     and updated_at < now() - interval '10 minutes';

  update public.xano_mirror_queue
     set status = 'sending', attempts = attempts + 1, updated_at = now()
   where id in (
     select id
       from public.xano_mirror_queue
      where status = 'pending'
        and next_attempt_at <= now()
      order by next_attempt_at, id
      limit batch
      for update skip locked
   )
  returning *;
$$;

revoke all on function public.claim_xano_mirror_rows(integer) from public, anon, authenticated;
grant execute on function public.claim_xano_mirror_rows(integer) to service_role;

-- ── every minute ─────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from cron.job where jobname = 'xano-mirror-dispatch') then
    perform cron.unschedule('xano-mirror-dispatch');
  end if;
end $$;

select cron.schedule(
  'xano-mirror-dispatch',
  '* * * * *',
  $cron$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/xano-mirror-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $cron$
);
