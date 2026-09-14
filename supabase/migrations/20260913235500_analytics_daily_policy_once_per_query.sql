-- analytics_daily RLS: look the staffer up once per query, not once per row.
--
-- The first policy correlated on analytics_daily.business_id inside an EXISTS,
-- so Postgres re-ran current_staff() for every row it scanned: a year view
-- (16,000 rows) cost 234 ms as an owner against 37 ms as the admin. Written as
-- two uncorrelated scalar subqueries, each becomes an InitPlan evaluated once.
-- Same answer: owner sees all, business manager sees own business, anyone
-- else (check-in, not staff) sees nothing.

drop policy if exists analytics_daily_select on public.analytics_daily;
create policy analytics_daily_select on public.analytics_daily
  for select using (
    coalesce((select cs.role = 'owner' from public.current_staff() cs), false)
    or analytics_daily.business_id = (
      select cs.business_id from public.current_staff() cs where cs.role = 'business_manager'
    )
  );
