-- Analytics: one "Groupon" source.
--
-- /gp bookings are written with source_channel 'groupon'. The Xano mirror sends them to
-- Xano as 'groupon-surcharge' (Xano's channel name) and the sync back rewrites our row to
-- that, so the same vouchers showed up as two sources on /analytics. Fold both into one
-- label at read time. The stored value is untouched: RLS (unpaid /gp rows), the Redeem
-- chip and the mirror all key on it.
--
-- Same body as before otherwise: source x tour x business, aggregated in the database,
-- SECURITY INVOKER so RLS scopes the caller.

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
  select
    case
      when lower(btrim(b.source_channel)) in ('groupon', 'groupon-surcharge') then 'Groupon'
      else coalesce(nullif(btrim(b.source_channel), ''), 'Direct')
    end                                                      as source,
    coalesce(t.name, bt.name, 'Unknown')                    as tour,
    t.color                                                  as color,
    biz.id                                                   as business_id,
    biz.name                                                 as business,
    sum(b.pax_adult + b.pax_child + b.pax_infant)::bigint    as pax,
    count(*)::bigint                                         as bookings
  from bookings b
  join business_tours bt on bt.id = b.business_tour_id
  join businesses biz on biz.id = b.business_id
  left join tours t on t.id = bt.tour_id
  where b.starts_at >= p_start
    and b.starts_at <  p_end
    and b.status <> 'cancelled'
  group by 1, 2, 3, 4, 5
$$;
