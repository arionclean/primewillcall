-- Kiosk breakdown for /analytics.
--
-- Every tablet sale lands as one of three source_channel values
-- ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap'), so the Sources list
-- could only ever say "Kiosk - Cash" and "Kiosk - Card": four tablets in one
-- pile. The owner wants the tablet itself, then how it was paid, then the
-- product, then the bookings behind it.
--
-- A booking row does not carry a kiosk; the sale row does. The two are tied by
-- the KS- code the tablet mints (cash_sales.booking_ref = bookings.legacy_id),
-- with two fallbacks for sales the tablet wrote a different way: the card flow
-- v2 sale (kiosk_sales.booking_id) and the charge itself
-- (stripe_transactions.source is the kiosk slug). Sales made before this
-- platform recorded them resolve to nothing; those bookings stay together under
-- "Kiosk (unknown)" instead of being dropped, so the kiosk pax still add up to
-- what the Sources list shows.
--
-- The name shown is the one the owner gave the tablet's own login on Team
-- (staff.full_name, matched by staff.kiosk_slug), so renaming a kiosk there
-- renames it here. kiosks.name and the slug are the fallbacks.
--
-- Both functions are SECURITY INVOKER, so RLS scopes them exactly like
-- analytics_source_tour: owner sees everything, a manager only their business.

-- The KS- code is how a sale finds its booking. Unindexed until now.
create index if not exists cash_sales_booking_ref_idx
  on public.cash_sales (booking_ref);

create or replace function public.analytics_kiosk_source_tour(
  p_start timestamptz,
  p_end   timestamptz
)
returns table (
  kiosk_slug  text,
  kiosk       text,
  pay_type    text,
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
  with rows as (
    select
      b.id,
      b.business_id,
      (b.pax_adult + b.pax_child + b.pax_infant)                       as pax,
      case when b.source_channel = 'kiosk-sale-cash'
           then 'cash' else 'card' end                                 as pay_type,
      coalesce(sale.kiosk_slug, ks.kiosk_slug, tx.source)              as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
      t.color                                                          as color
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    -- one row each: a sale is one kiosk, and a stray duplicate must not
    -- multiply the booking into the count.
    left join lateral (
      select cs.kiosk_slug from cash_sales cs
      where cs.booking_ref = b.legacy_id limit 1
    ) sale on true
    left join lateral (
      select s.kiosk_slug from kiosk_sales s
      where s.booking_id = b.id limit 1
    ) ks on true
    left join lateral (
      select st.source from stripe_transactions st
      where st.booking_id = b.id and st.source like 'kiosk%' limit 1
    ) tx on true
    where b.starts_at >= p_start
      and b.starts_at <  p_end
      and b.status <> 'cancelled'
      and b.source_channel in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
  )
  select
    coalesce(r.slug, 'unknown')                    as kiosk_slug,
    coalesce(sn.full_name, k.name, r.slug,
             'Kiosk (unknown)')                    as kiosk,
    r.pay_type,
    r.tour,
    r.color,
    r.business_id,
    biz.name                                       as business,
    sum(r.pax)::bigint                             as pax,
    count(*)::bigint                               as bookings
  from rows r
  join businesses biz on biz.id = r.business_id
  left join kiosks k on k.slug = r.slug
  left join lateral (
    select nullif(btrim(st.full_name), '') as full_name
    from staff st
    where st.kiosk_slug = r.slug
    order by st.is_active desc
    limit 1
  ) sn on true
  group by 1, 2, 3, 4, 5, 6, 7
$$;

comment on function public.analytics_kiosk_source_tour(timestamptz, timestamptz) is
  'Kiosk tablet sales for /analytics: kiosk x cash|card x product, aggregated in the database. RLS scopes the caller.';

-- The bookings behind one kiosk cell. Same shape as analytics_bookings so the
-- page maps both results the same way; p_pay_type null means both.
create or replace function public.analytics_kiosk_bookings(
  p_start       timestamptz,
  p_end         timestamptz,
  p_kiosk_slug  text default null,
  p_pay_type    text default null,
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
      (b.pax_adult + b.pax_child + b.pax_infant)                       as pax,
      b.status::text                                                   as status,
      b.created_at,
      case when b.source_channel = 'kiosk-sale-cash'
           then 'cash' else 'card' end                                 as pay_type,
      coalesce(sale.kiosk_slug, ks.kiosk_slug, tx.source)              as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
      biz.name                                                         as business
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join customers c on c.id = b.customer_id
    left join lateral (
      select cs.kiosk_slug from cash_sales cs
      where cs.booking_ref = b.legacy_id limit 1
    ) sale on true
    left join lateral (
      select s.kiosk_slug from kiosk_sales s
      where s.booking_id = b.id limit 1
    ) ks on true
    left join lateral (
      select st.source from stripe_transactions st
      where st.booking_id = b.id and st.source like 'kiosk%' limit 1
    ) tx on true
    where b.starts_at >= p_start
      and b.starts_at <  p_end
      and b.status <> 'cancelled'
      and b.source_channel in ('kiosk-sale-cash', 'kiosk-sale-card', 'kiosk-sale-tap')
      and (p_business_id is null or b.business_id = p_business_id)
  )
  select
    r.id,
    r.starts_at,
    r.customer,
    r.pax,
    r.status,
    r.created_at,
    coalesce(sn.full_name, k.name, r.slug, 'Kiosk (unknown)') as source,
    r.tour,
    r.business
  from rows r
  left join kiosks k on k.slug = r.slug
  left join lateral (
    select nullif(btrim(st.full_name), '') as full_name
    from staff st
    where st.kiosk_slug = r.slug
    order by st.is_active desc
    limit 1
  ) sn on true
  where (p_kiosk_slug is null or coalesce(r.slug, 'unknown') = p_kiosk_slug)
    and (p_pay_type   is null or r.pay_type = p_pay_type)
    and (p_tour       is null or r.tour     = p_tour)
  order by r.starts_at, r.customer
  limit 300
$$;

comment on function public.analytics_kiosk_bookings(timestamptz, timestamptz, text, text, text, uuid) is
  'The bookings behind one /analytics kiosk cell (kiosk, optional cash|card, optional product). RLS scopes the caller.';

-- analytics_source_tour keeps its two-argument form exactly as it was, so the
-- deployed site is untouched until this ships. The page asks for the same rows
-- minus the three kiosk channels through a third argument, and adds the
-- per-kiosk rows back itself; that way a tablet sale is counted once.
create or replace function public.analytics_source_tour(
  p_start         timestamptz,
  p_end           timestamptz,
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
  select
    coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct') as source,
    coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
    t.color                                                           as color,
    biz.id                                                            as business_id,
    biz.name                                                          as business,
    sum(b.pax_adult + b.pax_child + b.pax_infant)::bigint             as pax,
    count(*)::bigint                                                  as bookings
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
  group by 1, 2, 3, 4, 5
$$;

comment on function public.analytics_source_tour(timestamptz, timestamptz, boolean) is
  'analytics_source_tour with p_exclude_kiosk: leaves out the tablet channels, which analytics_kiosk_source_tour returns split by kiosk.';
