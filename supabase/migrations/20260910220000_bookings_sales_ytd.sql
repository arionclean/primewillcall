-- Bookings sold so far this year, for the owner's sidebar.
--
-- "Sold" is the sale date, coalesce(booked_at, created_at), not the departure:
-- the sidebar answers "how are we selling", so a booking made today for
-- December belongs to today. Same basis as the Sales tab on /analytics.
--
-- One aggregate returning one row, on the coalesce index, so the sidebar never
-- pulls booking rows into the browser. The component calls it once per session
-- and then keeps the number current from the Realtime stream instead of asking
-- again.
--
-- Excludes the two things a sale is not: a cancelled booking, and a checkout
-- someone abandoned without paying.
--
-- SECURITY INVOKER, so RLS still scopes it: a manager calling it would see only
-- their own business. The sidebar renders it for the owner alone.

create or replace function public.bookings_sales_ytd()
returns table (bookings bigint, guests bigint)
language sql
stable
set search_path to 'public'
as $$
  select
    count(*)::bigint,
    coalesce(sum(b.pax_adult + b.pax_child + b.pax_infant), 0)::bigint
  from bookings b
  where b.status <> 'cancelled'
    and not b.awaiting_payment
    and coalesce(b.booked_at, b.created_at)
        >= date_trunc('year', (now() at time zone 'America/New_York'))
           at time zone 'America/New_York'
$$;
