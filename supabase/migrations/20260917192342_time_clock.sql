-- Time clock: the people who type a PIN on the tablets clock in and out, and the
-- owner reads the hours.
--
-- The pieces already in place do most of the work: kiosk_employees is the pool of
-- people with a PIN (one pool, any tablet), and the tablet already knows how to ask
-- for a PIN. This adds the record.
--
--   * one row per shift (clock in -> clock out), never one row per punch, so
--     "who is on the clock" is `clock_out_at is null` and a day's hours is a sum
--     over a handful of rows;
--   * a partial unique index makes a second clock-in impossible while a shift is
--     open, whichever tablet it comes from (the pool is shared, so two desks could
--     otherwise open two shifts for one person);
--   * a photo taken by the tablet at clock in, in a PRIVATE bucket (it is a picture
--     of a person: only the owner may look, through a signed URL);
--   * a forgotten clock out is closed overnight by time_clock_auto_close() at the
--     last time that person typed their PIN that day, and flagged for the owner to
--     confirm or fix. Guessing low and flagging beats counting to midnight.
--
-- Owner only, by the owner's choice: RLS lets no manager or desk read a row. The
-- tablet never reads or writes the table directly; the kiosk-clock edge function
-- does, with the service role, after checking the PIN itself.
--
-- The switch is kiosks.time_clock (default false), served to the tablet by
-- kiosk-config and enforced again in kiosk-clock, so a tablet cannot clock anyone
-- in until the owner turns that kiosk on. Old builds never see it.

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------
alter table public.kiosks
  add column if not exists time_clock boolean not null default false;

comment on column public.kiosks.time_clock is
  'When true this tablet offers Clock in / out (build 23+) and kiosk-clock accepts its punches. Off: the button is hidden and the function refuses.';

-- ---------------------------------------------------------------------------
-- The shifts
-- ---------------------------------------------------------------------------
create table if not exists public.time_clock_shifts (
  id                  uuid primary key default gen_random_uuid(),
  -- The person. Kept nullable with the name copied alongside, exactly like
  -- kiosk_events: removing an employee must never delete their hours.
  employee_id         uuid references public.kiosk_employees(id) on delete set null,
  employee_name       text not null,

  clock_in_at         timestamptz not null,
  clock_in_kiosk_id   uuid references public.kiosks(id) on delete set null,
  clock_in_kiosk_slug text,
  -- Path in the private time-clock-photos bucket. Null when the tablet had no
  -- camera or the upload failed: a missing photo never blocks a clock in.
  photo_path          text,

  clock_out_at        timestamptz,
  clock_out_kiosk_id  uuid references public.kiosks(id) on delete set null,
  clock_out_kiosk_slug text,

  -- Set when the nightly job closed it instead of the person. Until reviewed_at
  -- is set, the owner's screen flags it as "Forgot to clock out".
  auto_closed_at      timestamptz,
  reviewed_at         timestamptz,
  -- Set when the owner changed a time by hand. Who and what is in audit_log.
  edited_at           timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint time_clock_shifts_order check (clock_out_at is null or clock_out_at >= clock_in_at)
);

comment on table public.time_clock_shifts is
  'One row per worked shift: a kiosk employee clocked in on a tablet and clocked out again. Written by the kiosk-clock edge function, closed overnight by time_clock_auto_close() when someone forgot, read by the owner on /admin/staff/hours.';

-- At most one open shift per person, whichever tablet they used.
create unique index if not exists time_clock_shifts_open_idx
  on public.time_clock_shifts (employee_id)
  where clock_out_at is null;

-- The owner's screen reads a date range, newest first, sometimes for one person.
create index if not exists time_clock_shifts_in_idx
  on public.time_clock_shifts (clock_in_at desc);
create index if not exists time_clock_shifts_employee_in_idx
  on public.time_clock_shifts (employee_id, clock_in_at desc);

drop trigger if exists time_clock_shifts_set_updated_at on public.time_clock_shifts;
create trigger time_clock_shifts_set_updated_at before update on public.time_clock_shifts
  for each row execute function public.set_updated_at();

-- Owner edits are logged like every other staff edit (the trigger skips writes
-- with no auth.uid(), which is every write the kiosk-clock function makes).
drop trigger if exists trg_log_staff_change on public.time_clock_shifts;
create trigger trg_log_staff_change after insert or update or delete on public.time_clock_shifts
  for each row execute function public.log_staff_change();

alter table public.time_clock_shifts enable row level security;

drop policy if exists time_clock_shifts_owner_all on public.time_clock_shifts;
create policy time_clock_shifts_owner_all on public.time_clock_shifts
  for all to authenticated
  using      (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- The owner's screen stays live while people clock in and out.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'time_clock_shifts'
  ) then
    alter publication supabase_realtime add table public.time_clock_shifts;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The clock-in photos (private)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'time-clock-photos',
  'time-clock-photos',
  false,
  5242880, -- 5 MB; the tablet sends a small JPEG
  array['image/jpeg','image/jpg','image/png']::text[]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Only the owner may look at a photo of a person. The tablet's upload goes
-- through the service role, which bypasses storage RLS, so there is no insert
-- policy here.
drop policy if exists time_clock_photos_select on storage.objects;
create policy time_clock_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'time-clock-photos'
    and exists (select 1 from public.current_staff() cs where cs.role = 'owner')
  );

-- ---------------------------------------------------------------------------
-- Hours per person for a range, aggregated in the database
-- ---------------------------------------------------------------------------
/**
 * One row per person for the range picked on the Hours screen: shifts, the days
 * they worked, the minutes, and how many rows still need the owner's eye. An
 * open shift counts up to now, so "this week" reads as the week so far.
 *
 * SECURITY INVOKER (the default), so the owner-only policy above still decides
 * what it can see. Shifts are filed under the day they started.
 */
create or replace function public.time_clock_hours(p_start timestamptz, p_end timestamptz)
returns table (
  employee_id   uuid,
  employee_name text,
  shifts        bigint,
  days          bigint,
  minutes       bigint,
  open_shifts   bigint,
  needs_review  bigint
)
language sql
stable
set search_path = public
as $$
  select
    s.employee_id,
    s.employee_name,
    count(*)::bigint,
    count(distinct (s.clock_in_at at time zone 'America/New_York')::date)::bigint,
    coalesce(sum(
      extract(epoch from (coalesce(s.clock_out_at, now()) - s.clock_in_at)) / 60
    ), 0)::bigint,
    count(*) filter (where s.clock_out_at is null)::bigint,
    count(*) filter (where s.auto_closed_at is not null and s.reviewed_at is null)::bigint
  from public.time_clock_shifts s
  where s.clock_in_at >= p_start
    and s.clock_in_at <  p_end
  group by s.employee_id, s.employee_name
  order by s.employee_name;
$$;

comment on function public.time_clock_hours(timestamptz, timestamptz) is
  'Per-person totals for the Hours screen (shifts, days, minutes, open, to review) over a range of clock-in times. Invoker rights: owner only, through the time_clock_shifts policy.';

-- ---------------------------------------------------------------------------
-- The forgotten clock out
-- ---------------------------------------------------------------------------
/**
 * Close every shift left open on an earlier New York day, and flag it.
 *
 * The end is the last time that person typed their PIN that day (kiosk-pin-verify
 * records a pin_ok event for every PIN, whether it opened a tablet or a sale), and
 * the clock-in time itself when there is nothing. So the number the owner sees is
 * never invented upwards: a shift closed here reads short rather than long, and
 * carries auto_closed_at until the owner confirms or corrects it.
 *
 * Definer, because pg_cron runs it as the database owner and nobody else may.
 */
create or replace function public.time_clock_auto_close()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today_start timestamptz := (date_trunc('day', (now() at time zone 'America/New_York')) at time zone 'America/New_York');
  v_closed      integer;
begin
  with stale as (
    select
      s.id,
      s.employee_id,
      s.clock_in_at,
      -- Midnight at the end of the New York day this shift started in, so a shift
      -- missed for several days is still closed on its own day.
      ((((s.clock_in_at at time zone 'America/New_York')::date + 1)::timestamp) at time zone 'America/New_York') as day_end
    from public.time_clock_shifts s
    where s.clock_out_at is null
      and s.clock_in_at < v_today_start
  ),
  ends as (
    select
      st.id,
      coalesce((
        select max(e.at)
        from public.kiosk_events e
        where e.employee_id = st.employee_id
          and e.event = 'pin_ok'
          and e.at > st.clock_in_at
          and e.at < st.day_end
      ), st.clock_in_at) as end_at
    from stale st
  )
  update public.time_clock_shifts t
     set clock_out_at   = ends.end_at,
         auto_closed_at = now()
    from ends
   where t.id = ends.id
     and t.clock_out_at is null;

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

comment on function public.time_clock_auto_close() is
  'Nightly: closes shifts left open on an earlier New York day at that person''s last PIN of the day and flags them (auto_closed_at). Scheduled as the time-clock-auto-close cron job.';

revoke all on function public.time_clock_auto_close() from public;
revoke all on function public.time_clock_auto_close() from anon, authenticated;

-- 08:00 UTC is 4 AM in New York: after the latest desk closes, before the first
-- opens, so a shift is only ever closed once the day it belongs to is over.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'time-clock-auto-close') then
    perform cron.unschedule('time-clock-auto-close');
  end if;
end $$;

select cron.schedule('time-clock-auto-close', '0 8 * * *', $$select public.time_clock_auto_close()$$);
