-- Analytics drill-down: the bookings behind one source x tour cell.
--
-- /analytics shows sources and tours aggregated by analytics_source_tour. Clicking an
-- item in the right list opens the actual bookings behind it, so a number can be checked
-- against real names. Same filters as the aggregate (range, non-cancelled, optional
-- business) plus the source label and tour name exactly as the aggregate shows them, so
-- what you click is what you get. SECURITY INVOKER: bookings_select scopes the caller,
-- and the customers policy decides whether the name is readable (falls back to "Guest").
-- created_at is when the booking was made, so a desk entry can be told from an
-- advance one.
-- Capped at 300 rows; the screen says so and asks for a narrower range.

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
      coalesce(nullif(btrim(c.full_name), ''), 'Guest')                 as customer,
      (b.pax_adult + b.pax_child + b.pax_infant)                         as pax,
      b.status::text                                                     as status,
      b.created_at,
      coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct')  as source,
      coalesce(t.name, bt.name, 'Unknown')                               as tour,
      biz.name                                                           as business
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
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
  where (p_source is null or source = p_source)
    and (p_tour   is null or tour   = p_tour)
  order by starts_at, customer
  limit 300
$$;
