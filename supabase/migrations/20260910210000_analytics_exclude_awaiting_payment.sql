-- Analytics counted bookings staff cannot see, and settles the function set.
--
-- bookings.awaiting_payment marks a booking parked on an unpaid Stripe Checkout
-- page: someone started a Groupon booking on /gp and never paid. The
-- bookings_select policy hides those, so an abandoned checkout never reaches a
-- staff screen. The analytics functions filtered on status alone, so the same
-- rows landed in the totals and the Sources list disagreed with the bookings
-- list with no visible reason. On 2026-09-10 that was 3 bookings and 5 guests;
-- all-time, 31 bookings.
--
-- This file also settles the four analytics functions in one place. They grew a
-- p_basis argument (Departures vs Sales) after the earlier files were written,
-- so the versions here are the definitive ones and the two- and three-argument
-- overloads those files left behind are dropped: an overload nobody calls is a
-- trap for the next person, and PostgREST picks by argument name.

drop function if exists public.analytics_source_tour(timestamptz, timestamptz);
drop function if exists public.analytics_source_tour(timestamptz, timestamptz, boolean);
drop function if exists public.analytics_kiosk_source_tour(timestamptz, timestamptz);
drop function if exists public.analytics_bookings(timestamptz, timestamptz, text, text, uuid);
drop function if exists public.analytics_kiosk_bookings(timestamptz, timestamptz, text, text, text, uuid);

create or replace function public.analytics_source_tour(
  p_start timestamptz, p_end timestamptz, p_exclude_kiosk boolean,
  p_basis text default 'departure'
)
returns table (
  source text, tour text, color text, business_id uuid, business text,
  pax bigint, bookings bigint
)
language sql stable set search_path to 'public'
as $$
  with base as (
    select
      btrim(b.source_channel)                        as raw,
      lower(nullif(btrim(b.source_channel), ''))     as key,
      l.label                                        as label,
      coalesce(tl.label, t.name, bt.name, 'Unknown') as tour,
      t.color                                        as color,
      biz.id                                         as business_id,
      biz.name                                       as business,
      (b.pax_adult + b.pax_child + b.pax_infant)     as pax
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join booking_source_labels l
           on lower(l.channel) = lower(btrim(b.source_channel))
    where b.status <> 'cancelled'
      and not b.awaiting_payment
      and (
        (p_basis is distinct from 'sale'
         and b.starts_at >= p_start and b.starts_at < p_end)
        or
        (p_basis = 'sale'
         and coalesce(b.booked_at, b.created_at) >= p_start
         and coalesce(b.booked_at, b.created_at) <  p_end)
      )
      and (
        not p_exclude_kiosk
        or coalesce(b.source_channel, '') not in
           ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      )
  ),
  canon as (
    select key, mode() within group (order by raw) as name
    from base where key is not null group by key
  )
  select
    coalesce(base.label, canon.name, 'Direct'), base.tour, base.color,
    base.business_id, base.business, sum(base.pax)::bigint, count(*)::bigint
  from base left join canon on canon.key = base.key
  group by 1, 2, 3, 4, 5
$$;

create or replace function public.analytics_kiosk_source_tour(
  p_start timestamptz, p_end timestamptz, p_basis text default 'departure'
)
returns table (
  kiosk_slug text, kiosk text, pay_type text, tour text, color text,
  business_id uuid, business text, pax bigint, bookings bigint
)
language sql stable set search_path to 'public'
as $$
  with rows as (
    select
      b.id, b.business_id,
      (b.pax_adult + b.pax_child + b.pax_infant)                       as pax,
      case when b.source_channel = 'kiosk-sale-cash'
           then 'cash' else 'card' end                                 as pay_type,
      coalesce(own.slug, sale.kiosk_slug, ks.kiosk_slug, tx.source)    as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
      t.color                                                          as color
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join kiosks own on own.id = b.kiosk_id
    left join lateral (select cs.kiosk_slug from cash_sales cs
                        where cs.booking_ref = b.legacy_id limit 1) sale on true
    left join lateral (select s.kiosk_slug from kiosk_sales s
                        where s.booking_id = b.id limit 1) ks on true
    left join lateral (select st.source from stripe_transactions st
                        where st.booking_id = b.id and st.source like 'kiosk%' limit 1) tx on true
    where b.status <> 'cancelled'
      and not b.awaiting_payment
      and b.source_channel in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      and (
        (p_basis is distinct from 'sale'
         and b.starts_at >= p_start and b.starts_at < p_end)
        or
        (p_basis = 'sale'
         and coalesce(b.booked_at, b.created_at) >= p_start
         and coalesce(b.booked_at, b.created_at) <  p_end)
      )
  )
  select
    coalesce(r.slug, 'unknown'),
    coalesce(sn.full_name, k.name, r.slug, 'Kiosk (unknown)'),
    r.pay_type, r.tour, r.color, r.business_id, biz.name,
    sum(r.pax)::bigint, count(*)::bigint
  from rows r
  join businesses biz on biz.id = r.business_id
  left join kiosks k on k.slug = r.slug
  left join lateral (
    select nullif(btrim(st.full_name), '') as full_name from staff st
    where st.kiosk_slug = r.slug order by st.is_active desc limit 1
  ) sn on true
  group by 1, 2, 3, 4, 5, 6, 7
$$;

create or replace function public.analytics_bookings(
  p_start timestamptz, p_end timestamptz, p_source text default null,
  p_tour text default null, p_business_id uuid default null,
  p_basis text default 'departure'
)
returns table (
  id uuid, starts_at timestamptz, customer text, pax integer, status text,
  created_at timestamptz, source text, tour text, business text
)
language sql stable set search_path to 'public'
as $$
  with rows as (
    select
      b.id, b.starts_at,
      coalesce(nullif(btrim(c.full_name), ''), 'Guest')                as customer,
      (b.pax_adult + b.pax_child + b.pax_infant)                       as pax,
      b.status::text                                                   as status,
      coalesce(b.booked_at, b.created_at)                              as created_at,
      coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct') as source,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
      biz.name                                                         as business
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join customers c on c.id = b.customer_id
    left join booking_source_labels l
           on lower(l.channel) = lower(btrim(b.source_channel))
    where b.status <> 'cancelled'
      and not b.awaiting_payment
      and (p_business_id is null or b.business_id = p_business_id)
      and (
        (p_basis is distinct from 'sale'
         and b.starts_at >= p_start and b.starts_at < p_end)
        or
        (p_basis = 'sale'
         and coalesce(b.booked_at, b.created_at) >= p_start
         and coalesce(b.booked_at, b.created_at) <  p_end)
      )
  )
  select id, starts_at, customer, pax, status, created_at, source, tour, business
  from rows
  where (p_source is null or lower(source) = lower(p_source))
    and (p_tour is null or tour = p_tour)
  order by starts_at, customer
  limit 300
$$;

create or replace function public.analytics_kiosk_bookings(
  p_start timestamptz, p_end timestamptz, p_kiosk_slug text default null,
  p_pay_type text default null, p_tour text default null,
  p_business_id uuid default null, p_basis text default 'departure'
)
returns table (
  id uuid, starts_at timestamptz, customer text, pax integer, status text,
  created_at timestamptz, source text, tour text, business text
)
language sql stable set search_path to 'public'
as $$
  with rows as (
    select
      b.id, b.starts_at,
      coalesce(nullif(btrim(c.full_name), ''), 'Guest')                as customer,
      (b.pax_adult + b.pax_child + b.pax_infant)                       as pax,
      b.status::text                                                   as status,
      coalesce(b.booked_at, b.created_at)                              as created_at,
      case when b.source_channel = 'kiosk-sale-cash'
           then 'cash' else 'card' end                                 as pay_type,
      coalesce(own.slug, sale.kiosk_slug, ks.kiosk_slug, tx.source)    as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
      biz.name                                                         as business
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join customers c on c.id = b.customer_id
    left join kiosks own on own.id = b.kiosk_id
    left join lateral (select cs.kiosk_slug from cash_sales cs
                        where cs.booking_ref = b.legacy_id limit 1) sale on true
    left join lateral (select s.kiosk_slug from kiosk_sales s
                        where s.booking_id = b.id limit 1) ks on true
    left join lateral (select st.source from stripe_transactions st
                        where st.booking_id = b.id and st.source like 'kiosk%' limit 1) tx on true
    where b.status <> 'cancelled'
      and not b.awaiting_payment
      and b.source_channel in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      and (p_business_id is null or b.business_id = p_business_id)
      and (
        (p_basis is distinct from 'sale'
         and b.starts_at >= p_start and b.starts_at < p_end)
        or
        (p_basis = 'sale'
         and coalesce(b.booked_at, b.created_at) >= p_start
         and coalesce(b.booked_at, b.created_at) <  p_end)
      )
  )
  select
    r.id, r.starts_at, r.customer, r.pax, r.status, r.created_at,
    coalesce(sn.full_name, k.name, r.slug, 'Kiosk (unknown)'),
    r.tour, r.business
  from rows r
  left join kiosks k on k.slug = r.slug
  left join lateral (
    select nullif(btrim(st.full_name), '') as full_name from staff st
    where st.kiosk_slug = r.slug order by st.is_active desc limit 1
  ) sn on true
  where (p_kiosk_slug is null or coalesce(r.slug, 'unknown') = p_kiosk_slug)
    and (p_pay_type is null or r.pay_type = p_pay_type)
    and (p_tour is null or r.tour = p_tour)
  order by r.starts_at, r.customer
  limit 300
$$;
