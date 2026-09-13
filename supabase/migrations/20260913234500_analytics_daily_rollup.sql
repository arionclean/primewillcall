-- Analytics rollup: reports read one small table instead of the bookings table.
--
-- Why. On 2026-09-13 the analytics aggregates and the sidebar's "Sold this
-- year" read the whole bookings table on every call (98,000 rows; the "sale"
-- basis with no usable index) and, retried under load, stalled the database
-- for fifteen minutes at Saturday peak. A report must not cost more as the
-- business grows.
--
-- What. analytics_daily holds one row per (basis, New York day, business,
-- product, source, kiosk) with the guests and bookings that count: not
-- cancelled, not an unpaid checkout. Two bases, because a report asks either
-- "who departs on this day" (departure, starts_at) or "what did we sell on
-- this day" (sale, coalesce(booked_at, created_at)). A day of reports is a few
-- dozen rows, a month a few hundred, the year to date a few thousand, and none
-- of it touches bookings. Today that is about 34,000 rows for 98,000 bookings.
--
-- Kept current two ways. A trigger on bookings applies the delta of every
-- insert, update and delete (old row out, new row in; an edit that changes no
-- counted field, such as a check-in, writes nothing). A nightly rebuild
-- recomputes the table from bookings, which also settles the kiosk attribution
-- of the few legacy rows whose kiosk_id is null and only resolvable through
-- the ledgers.
--
-- Read side. The four report functions keep their signatures and row shapes
-- and now read the rollup. Labels (booking_source_labels, tour_analytics_labels)
-- are joined at read time, so renaming a source or a product needs no rebuild.
-- RLS on the rollup scopes it like bookings (owner all, manager own business);
-- the functions stay SECURITY INVOKER. bookings_sales_ytd gets its execute
-- grant back (revoked on 2026-09-13 while it scanned the year).

-- ── The table ────────────────────────────────────────────────────────────────

create table if not exists public.analytics_daily (
  basis            text   not null check (basis in ('departure', 'sale')),
  day              date   not null,
  business_id      uuid   not null references public.businesses(id) on delete cascade,
  business_tour_id uuid   not null references public.business_tours(id) on delete cascade,
  source           text   not null default '',
  kiosk_id         uuid,
  pax              bigint not null default 0,
  bookings         bigint not null default 0,
  constraint analytics_daily_key
    unique nulls not distinct (basis, day, business_id, business_tour_id, source, kiosk_id)
);

comment on table public.analytics_daily is
  'Daily rollup of bookings for reports: one row per basis, New York day, business, product, source and kiosk. Counts only bookings that are not cancelled and not an unpaid checkout. Kept current by the analytics_daily_sync trigger on bookings and rebuilt nightly by analytics_daily_rebuild(). Derived data: never edit by hand, rebuild instead.';
comment on column public.analytics_daily.basis is
  'departure = the day the tour departs (starts_at); sale = the day it was sold (coalesce(booked_at, created_at)). Both in America/New_York.';
comment on column public.analytics_daily.source is
  'bookings.source_channel, trimmed; empty string when the booking has none. Labels are joined at read time.';
comment on column public.analytics_daily.kiosk_id is
  'bookings.kiosk_id; the nightly rebuild also resolves it through the ledgers for legacy rows. Null for anything that is not a kiosk sale.';

alter table public.analytics_daily enable row level security;

drop policy if exists analytics_daily_select on public.analytics_daily;
create policy analytics_daily_select on public.analytics_daily
  for select using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = analytics_daily.business_id)
    )
  );

grant select on public.analytics_daily to authenticated;

-- ── Keeping it current ───────────────────────────────────────────────────────

-- One booking's contribution, added (sign = 1) or removed (sign = -1).
create or replace function public.analytics_daily_apply(b public.bookings, sign integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.analytics_daily
    (basis, day, business_id, business_tour_id, source, kiosk_id, pax, bookings)
  values
    ('departure',
     (b.starts_at at time zone 'America/New_York')::date,
     b.business_id, b.business_tour_id, btrim(coalesce(b.source_channel, '')), b.kiosk_id,
     sign * (b.pax_adult + b.pax_child + b.pax_infant), sign),
    ('sale',
     (coalesce(b.booked_at, b.created_at) at time zone 'America/New_York')::date,
     b.business_id, b.business_tour_id, btrim(coalesce(b.source_channel, '')), b.kiosk_id,
     sign * (b.pax_adult + b.pax_child + b.pax_infant), sign)
  on conflict (basis, day, business_id, business_tour_id, source, kiosk_id)
  do update set
    pax      = analytics_daily.pax      + excluded.pax,
    bookings = analytics_daily.bookings + excluded.bookings;
$$;

create or replace function public.analytics_daily_on_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_counts boolean := false;
  new_counts boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_counts := old.status <> 'cancelled' and not coalesce(old.awaiting_payment, false);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_counts := new.status <> 'cancelled' and not coalesce(new.awaiting_payment, false);
  end if;

  -- An edit that changes nothing the rollup counts (a check-in, a note, a
  -- balance, a void of a booking that was already cancelled) writes nothing.
  if tg_op = 'UPDATE' and old_counts = new_counts and (
       not new_counts or (
         old.starts_at = new.starts_at
         and coalesce(old.booked_at, old.created_at) = coalesce(new.booked_at, new.created_at)
         and old.business_id = new.business_id
         and old.business_tour_id = new.business_tour_id
         and coalesce(old.source_channel, '') = coalesce(new.source_channel, '')
         and old.kiosk_id is not distinct from new.kiosk_id
         and old.pax_adult + old.pax_child + old.pax_infant
             = new.pax_adult + new.pax_child + new.pax_infant
       )
     ) then
    return null;
  end if;

  if old_counts then perform public.analytics_daily_apply(old, -1); end if;
  if new_counts then perform public.analytics_daily_apply(new, 1); end if;
  return null;
end;
$$;

drop trigger if exists analytics_daily_sync on public.bookings;
create trigger analytics_daily_sync
  after insert or update or delete on public.bookings
  for each row execute function public.analytics_daily_on_booking();

-- Full recompute from bookings. Nightly, and whenever the rollup is in doubt.
-- TRUNCATE takes the table lock on purpose: a booking written while this runs
-- waits, then applies its delta on top of the fresh copy, so nothing is lost
-- or counted twice.
create or replace function public.analytics_daily_rebuild()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  truncate public.analytics_daily;

  insert into public.analytics_daily
    (basis, day, business_id, business_tour_id, source, kiosk_id, pax, bookings)
  select x.basis, x.day, x.business_id, x.business_tour_id, x.source, x.kiosk_id,
         sum(x.pax), count(*)
  from (
    select
      b.business_id,
      b.business_tour_id,
      btrim(coalesce(b.source_channel, '')) as source,
      coalesce(
        b.kiosk_id,
        case when b.source_channel in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap') then (
          -- The same fallback chain the report used to run per booking, now
          -- once a night for the handful of legacy rows without kiosk_id.
          select k.id from public.kiosks k
          where k.slug = coalesce(
            (select cs.kiosk_slug from public.cash_sales cs where cs.booking_ref = b.legacy_id limit 1),
            (select s.kiosk_slug  from public.kiosk_sales s  where s.booking_id  = b.id limit 1),
            (select st.source     from public.stripe_transactions st
              where st.booking_id = b.id and st.source like 'kiosk%' limit 1))
          limit 1
        ) end
      ) as kiosk_id,
      (b.pax_adult + b.pax_child + b.pax_infant) as pax,
      v.basis,
      v.day
    from public.bookings b
    cross join lateral (values
      ('departure', (b.starts_at at time zone 'America/New_York')::date),
      ('sale',      (coalesce(b.booked_at, b.created_at) at time zone 'America/New_York')::date)
    ) as v(basis, day)
    where b.status <> 'cancelled'
      and not coalesce(b.awaiting_payment, false)
  ) x
  group by 1, 2, 3, 4, 5, 6;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.analytics_daily_rebuild() from public, anon, authenticated;
revoke all on function public.analytics_daily_apply(public.bookings, integer) from public, anon, authenticated;
revoke all on function public.analytics_daily_on_booking() from public, anon, authenticated;

-- First fill.
select public.analytics_daily_rebuild();

-- Nightly rebuild at 4:30 AM New York (8:30 UTC), before the desks open.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'analytics-daily-rebuild') then
    perform cron.unschedule('analytics-daily-rebuild');
  end if;
end $$;
select cron.schedule('analytics-daily-rebuild', '30 8 * * *', $$select public.analytics_daily_rebuild()$$);

-- ── The reports, now reading the rollup (same signatures, same shapes) ──────

create or replace function public.analytics_source_tour(
  p_start timestamptz,
  p_end timestamptz,
  p_exclude_kiosk boolean,
  p_basis text default 'departure'
)
returns table (source text, tour text, color text, business_id uuid, business text, pax bigint, bookings bigint)
language sql
stable
set search_path = public
as $$
  with base as (
    select
      d.source                                        as raw,
      lower(nullif(d.source, ''))                     as key,
      l.label                                         as label,
      coalesce(tl.label, t.name, bt.name, 'Unknown')  as tour,
      t.color                                         as color,
      biz.id                                          as business_id,
      biz.name                                        as business,
      d.pax                                           as pax,
      d.bookings                                      as bookings
    from analytics_daily d
    join business_tours bt on bt.id = d.business_tour_id
    join businesses biz on biz.id = d.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join booking_source_labels l on lower(l.channel) = lower(d.source)
    where d.basis = case when p_basis = 'sale' then 'sale' else 'departure' end
      and d.day >= (p_start at time zone 'America/New_York')::date
      and d.day <  (p_end   at time zone 'America/New_York')::date
      and (
        not p_exclude_kiosk
        or d.source not in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      )
  ),
  -- One display spelling per source key: the one with the most bookings.
  canon as (
    select key, (array_agg(raw order by bookings desc, raw))[1] as name
    from (select key, raw, sum(bookings) as bookings from base where key is not null group by key, raw) s
    group by key
  )
  select
    coalesce(base.label, canon.name, 'Direct'), base.tour, base.color,
    base.business_id, base.business, sum(base.pax)::bigint, sum(base.bookings)::bigint
  from base left join canon on canon.key = base.key
  group by 1, 2, 3, 4, 5
$$;

create or replace function public.analytics_kiosk_source_tour(
  p_start timestamptz,
  p_end timestamptz,
  p_basis text default 'departure'
)
returns table (kiosk_slug text, kiosk text, pay_type text, tour text, color text, business_id uuid, business text, pax bigint, bookings bigint)
language sql
stable
set search_path = public
as $$
  with rows as (
    select
      d.business_id,
      d.pax,
      d.bookings,
      case when d.source = 'kiosk-sale-cash' then 'cash' else 'card' end  as pay_type,
      k.slug                                                              as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                      as tour,
      t.color                                                             as color
    from analytics_daily d
    join business_tours bt on bt.id = d.business_tour_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join kiosks k on k.id = d.kiosk_id
    where d.basis = case when p_basis = 'sale' then 'sale' else 'departure' end
      and d.day >= (p_start at time zone 'America/New_York')::date
      and d.day <  (p_end   at time zone 'America/New_York')::date
      and d.source in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
  )
  select
    coalesce(r.slug, 'unknown'),
    coalesce(sn.full_name, k.name, r.slug, 'Kiosk (unknown)'),
    r.pay_type, r.tour, r.color, r.business_id, biz.name,
    sum(r.pax)::bigint, sum(r.bookings)::bigint
  from rows r
  join businesses biz on biz.id = r.business_id
  left join kiosks k on k.slug = r.slug
  left join lateral (
    select nullif(btrim(st.full_name), '') as full_name from staff st
    where st.kiosk_slug = r.slug order by st.is_active desc limit 1
  ) sn on true
  group by 1, 2, 3, 4, 5, 6, 7
$$;

-- p_tz stays in the signature for the callers; the rollup's day is the
-- business day (America/New_York), the only zone the app reports in.
create or replace function public.analytics_daily_by_tour(
  p_start timestamptz,
  p_end timestamptz,
  p_tz text
)
returns table (day integer, business_tour_id uuid, tour text, color text, pax bigint, bookings bigint)
language sql
stable
set search_path = public
as $$
  select
    extract(day from d.day)::int,
    d.business_tour_id,
    coalesce(tl.label, t.name, bt.name, 'Unknown'),
    t.color,
    sum(d.pax)::bigint,
    sum(d.bookings)::bigint
  from analytics_daily d
  join business_tours bt on bt.id = d.business_tour_id
  left join tours t on t.id = bt.tour_id
  left join tour_analytics_labels tl on tl.tour_id = t.id
  where d.basis = 'departure'
    and d.day >= (p_start at time zone 'America/New_York')::date
    and d.day <  (p_end   at time zone 'America/New_York')::date
  group by 1, 2, 3, 4
$$;

create or replace function public.bookings_sales_ytd()
returns table (bookings bigint, guests bigint)
language sql
stable
set search_path = public
as $$
  select coalesce(sum(d.bookings), 0)::bigint, coalesce(sum(d.pax), 0)::bigint
  from analytics_daily d
  where d.basis = 'sale'
    and d.day >= date_trunc('year', now() at time zone 'America/New_York')::date
$$;

grant execute on function public.bookings_sales_ytd() to authenticated;
comment on function public.bookings_sales_ytd() is
  'Bookings sold so far this year (sale basis), summed from the analytics_daily rollup. Owner sidebar.';
