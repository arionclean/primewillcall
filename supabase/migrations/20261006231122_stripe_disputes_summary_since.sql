-- The Disputes tab counts one period everywhere, the last 30 days (the owner's call,
-- 2026-10-06): card networks and Stripe judge the dispute rate month by month, so
-- the cards beside the rate count the same days. A dispute still waiting for an
-- answer always counts, however old, so a deadline can never fall out of view.
--
-- Replaces stripe_disputes_summary(uuid) with a version that takes the start of
-- the period. The old signature is dropped first: keeping both would make a call
-- with only p_business ambiguous. Without p_since it counts everything, as before.

drop function if exists public.stripe_disputes_summary(uuid);

create or replace function public.stripe_disputes_summary(
  p_business uuid default null,
  p_since timestamptz default null
)
returns table (bucket text, disputes integer, amount bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select d.bucket, count(*)::integer, coalesce(sum(d.amount), 0)::bigint
  from public.stripe_disputes d
  where (p_business is null or d.business_id = p_business)
    and (p_since is null or d.bucket = 'needs_response' or d.stripe_created >= p_since)
  group by d.bucket
$$;

revoke execute on function public.stripe_disputes_summary(uuid, timestamptz) from public, anon;
grant execute on function public.stripe_disputes_summary(uuid, timestamptz) to authenticated;
