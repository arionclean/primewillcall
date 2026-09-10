-- Analytics grouped sources by the exact text on the booking, so the same
-- partner typed two ways became two rows.
--
-- bookings.source_channel was free text for years. "South FL" arrived as
-- SOUTH FL, South FL, South Fl and south fl, one booking each, and analytics
-- listed four partners. Seven names were affected. Their rows have been
-- normalised in the data, but nothing stopped the next one: the Xano sync
-- still copies whatever Bokun or a Bubble-era staffer wrote.
--
-- The fix is in the grouping, not in the rows. An unlabelled channel is now
-- grouped case-insensitively and displayed as its most-used spelling, via
-- mode(). A channel that has a row in booking_source_labels keeps using the
-- label, exactly as before (that join was already case-insensitive). The label
-- is functionally dependent on the group key, so min() over it is that label.
--
-- analytics_bookings, the drill-down behind a source, matches its p_source
-- argument case-insensitively for the same reason: the name it is handed comes
-- from the grouped list above, and the rows behind it may be spelled otherwise.

create or replace function public.analytics_source_tour(
  p_start timestamptz,
  p_end   timestamptz,
  p_exclude_kiosk boolean
)
returns table (
  source      text,
  tour        text,
  color       text,
  business_id uuid,
  business    text,
  pax         bigint,
  bookings    bigint
)
language sql
stable
set search_path to 'public'
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
    where b.starts_at >= p_start
      and b.starts_at <  p_end
      and b.status <> 'cancelled'
      and (
        not p_exclude_kiosk
        or coalesce(b.source_channel, '') not in
           ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      )
  ),
  -- The spelling to show for a channel with no label: the one used most in
  -- this window. Every other capitalisation of it folds into this row.
  canon as (
    select key, mode() within group (order by raw) as name
    from base where key is not null group by key
  )
  select
    coalesce(base.label, canon.name, 'Direct')      as source,
    base.tour,
    base.color,
    base.business_id,
    base.business,
    sum(base.pax)::bigint                           as pax,
    count(*)::bigint                                as bookings
  from base
  left join canon on canon.key = base.key
  group by 1, 2, 3, 4, 5
$$;

-- The two-argument overload keeps the same behaviour as the three-argument one.
create or replace function public.analytics_source_tour(
  p_start timestamptz,
  p_end   timestamptz
)
returns table (
  source      text,
  tour        text,
  color       text,
  business_id uuid,
  business    text,
  pax         bigint,
  bookings    bigint
)
language sql
stable
set search_path to 'public'
as $$
  select * from public.analytics_source_tour(p_start, p_end, false)
$$;

create or replace function public.analytics_bookings(
  p_start       timestamptz,
  p_end         timestamptz,
  p_source      text default null,
  p_tour        text default null,
  p_business_id uuid default null
)
returns table (
  id         uuid,
  starts_at  timestamptz,
  customer   text,
  pax        integer,
  status     text,
  created_at timestamptz,
  source     text,
  tour       text,
  business   text
)
language sql
stable
set search_path to 'public'
as $$
  with rows as (
    select
      b.id,
      b.starts_at,
      coalesce(nullif(btrim(c.full_name), ''), 'Guest')                as customer,
      (b.pax_adult + b.pax_child + b.pax_infant)                        as pax,
      b.status::text                                                    as status,
      b.created_at,
      coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct')  as source,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                    as tour,
      biz.name                                                          as business
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join customers c on c.id = b.customer_id
    left join booking_source_labels l
           on lower(l.channel) = lower(btrim(b.source_channel))
    where b.starts_at >= p_start
      and b.starts_at <  p_end
      and b.status <> 'cancelled'
      and (p_business_id is null or b.business_id = p_business_id)
  )
  select id, starts_at, customer, pax, status, created_at, source, tour, business
  from rows
  where (p_source is null or lower(source) = lower(p_source))
    and (p_tour   is null or tour   = p_tour)
  order by starts_at, customer
  limit 300
$$;
