-- Recovered on 2026-09-17 from the database's migration log (applied 2026-06-03
-- 16:38 UTC). The dashboard has called dashboard_monthly_guests() since June
-- (src/lib/dashboard/queries.ts) and CLAUDE.md holds it up as the aggregation
-- pattern, yet no file on main defined it. Verbatim what ran; the function body is
-- byte-for-byte what is live.

-- Composite index so the per-business range scan is tight (managers).
create index if not exists bookings_business_starts_idx
  on bookings (business_id, starts_at);

-- Aggregate guests per day for a window, entirely in the database. Returns ~31
-- rows instead of thousands. SECURITY INVOKER so the caller's RLS still scopes
-- the rows (owner = all, manager = their business).
create or replace function public.dashboard_monthly_guests(
  p_start timestamptz,
  p_end timestamptz,
  p_tz text default 'America/New_York'
)
returns table (day int, guests bigint, checked_guests bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    extract(day from (b.starts_at at time zone p_tz))::int as day,
    sum(b.pax_adult + b.pax_child + b.pax_infant)::bigint as guests,
    sum(
      case when b.checked_in_at is not null
           then b.pax_adult + b.pax_child + b.pax_infant
           else 0 end
    )::bigint as checked_guests
  from bookings b
  where b.starts_at >= p_start
    and b.starts_at <  p_end
    and b.status <> 'cancelled'
  group by 1
$$;

grant execute on function public.dashboard_monthly_guests(timestamptz, timestamptz, text)
  to authenticated;
