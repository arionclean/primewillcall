-- The Sources list names the kiosk from the booking, not from a sale row.
--
-- analytics_kiosk_source_tour resolved the kiosk by matching the booking's
-- legacy_id to cash_sales.booking_ref, or kiosk_sales.booking_id, or a kiosk
-- stripe_transaction. Sales have only existed here since 2026-07-12, so 13,509
-- older kiosk bookings resolved to nothing and showed as "Kiosk (unknown)".
--
-- bookings.kiosk_id now holds the answer: backfilled from Xano for the history,
-- written by xano-booking-sync from here on. The three lookups stay as a
-- fallback, so a booking whose kiosk we could not resolve still finds its sale
-- if one exists, and the function keeps working while the backfill runs.

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
      -- The booking's own kiosk first. The sale lookups remain for a booking
      -- that has none yet.
      coalesce(own.slug, sale.kiosk_slug, ks.kiosk_slug, tx.source)    as slug,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
      t.color                                                          as color
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join kiosks own on own.id = b.kiosk_id
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
