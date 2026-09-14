-- Analytics reports: sum the rollup first, then attach names and labels.
--
-- Joining products, businesses and labels BEFORE summing made the planner, under
-- those tables' RLS checks, walk every rollup row against them with nested
-- loops: a year view was 6,000 rows x (21 products + 43 labels), 241 ms as an
-- owner against 37 ms as the admin. Summing first leaves a few hundred rows to
-- decorate. Same signatures, same row shapes, same numbers.

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
  with agg as (
    select
      d.business_id,
      d.business_tour_id,
      d.source                     as raw,
      lower(nullif(d.source, ''))  as key,
      sum(d.pax)                   as pax,
      sum(d.bookings)              as bookings
    from analytics_daily d
    where d.basis = case when p_basis = 'sale' then 'sale' else 'departure' end
      and d.day >= (p_start at time zone 'America/New_York')::date
      and d.day <  (p_end   at time zone 'America/New_York')::date
      and (
        not p_exclude_kiosk
        or d.source not in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      )
    group by 1, 2, 3, 4
  ),
  -- One display spelling per source key: the one with the most bookings.
  canon as (
    select key, (array_agg(raw order by bookings desc, raw))[1] as name
    from (select key, raw, sum(bookings) as bookings from agg where key is not null group by key, raw) s
    group by key
  ),
  base as (
    select
      coalesce(l.label, canon.name, 'Direct')          as source,
      coalesce(tl.label, t.name, bt.name, 'Unknown')   as tour,
      t.color                                          as color,
      biz.id                                           as business_id,
      biz.name                                         as business,
      a.pax                                            as pax,
      a.bookings                                       as bookings
    from agg a
    join business_tours bt on bt.id = a.business_tour_id
    join businesses biz on biz.id = a.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join booking_source_labels l on lower(l.channel) = a.key
    left join canon on canon.key = a.key
  )
  select base.source, base.tour, base.color, base.business_id, base.business,
         sum(base.pax)::bigint, sum(base.bookings)::bigint
  from base
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
  with agg as (
    select
      d.business_id,
      d.business_tour_id,
      d.kiosk_id,
      case when d.source = 'kiosk-sale-cash' then 'cash' else 'card' end as pay_type,
      sum(d.pax)      as pax,
      sum(d.bookings) as bookings
    from analytics_daily d
    where d.basis = case when p_basis = 'sale' then 'sale' else 'departure' end
      and d.day >= (p_start at time zone 'America/New_York')::date
      and d.day <  (p_end   at time zone 'America/New_York')::date
      and d.source in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
    group by 1, 2, 3, 4
  ),
  rows as (
    select
      a.business_id, a.pax, a.bookings, a.pay_type,
      k.slug                                          as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')  as tour,
      t.color                                         as color
    from agg a
    join business_tours bt on bt.id = a.business_tour_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join kiosks k on k.id = a.kiosk_id
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
  with agg as (
    select d.day, d.business_tour_id, sum(d.pax) as pax, sum(d.bookings) as bookings
    from analytics_daily d
    where d.basis = 'departure'
      and d.day >= (p_start at time zone 'America/New_York')::date
      and d.day <  (p_end   at time zone 'America/New_York')::date
    group by 1, 2
  )
  select
    extract(day from a.day)::int,
    a.business_tour_id,
    coalesce(tl.label, t.name, bt.name, 'Unknown'),
    t.color,
    sum(a.pax)::bigint,
    sum(a.bookings)::bigint
  from agg a
  join business_tours bt on bt.id = a.business_tour_id
  left join tours t on t.id = bt.tour_id
  left join tour_analytics_labels tl on tl.tour_id = t.id
  group by 1, 2, 3, 4
$$;
