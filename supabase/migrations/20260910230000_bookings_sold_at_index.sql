-- Recovered on 2026-09-17 from the database's migration log. The index was created
-- on 2026-09-10 at 17:55 UTC as the first statement of analytics_basis_departure_or_sale;
-- the three report functions that migration also defined were since rewritten on main
-- (20260913234500_analytics_daily_rollup), but the index stayed live and main never
-- had it. Stamped after 20260910190000_bookings_booked_at because it needs booked_at.

-- Index for the sale-date branch, so it is as cheap as the departure one.
create index if not exists bookings_sold_at_idx
  on public.bookings (coalesce(booked_at, created_at));
