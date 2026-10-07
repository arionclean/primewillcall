-- Dispute rate for the owner's Disputes tab: disputes opened in a window divided by
-- the card payments taken in the same window, the way card networks and Stripe
-- measure it (Stripe asks accounts to stay under 0.75%).
--
-- Our ledger (stripe_transactions) only starts when the webhook went live
-- (2026-07-12), while Stripe's disputes go back further. Comparing a full window of
-- disputes against a partial window of payments would overstate the rate, so the
-- window starts at the later of "p_days ago" and the first charge we hold, and
-- `since` says where it really started.
--
-- A payment is a card charge that went through (succeeded, later refunded, or
-- disputed). SECURITY INVOKER: stripe_disputes is owner only, so only the owner
-- gets a number; both counts read their own indexes (stripe_created).

create or replace function public.stripe_dispute_rate(p_business uuid default null, p_days integer default 90)
returns table (disputes integer, payments integer, since timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select greatest(
      now() - make_interval(days => greatest(p_days, 1)),
      coalesce(
        (select min(t.stripe_created) from public.stripe_transactions t where t.object_type = 'charge'),
        now()
      )
    ) as since
  )
  select
    (select count(*)::integer from public.stripe_disputes d, bounds b
      where d.stripe_created >= b.since
        and (p_business is null or d.business_id = p_business)),
    (select count(*)::integer from public.stripe_transactions t, bounds b
      where t.object_type = 'charge'
        and t.status in ('succeeded', 'refunded', 'disputed')
        and t.stripe_created >= b.since
        and (p_business is null or t.business_id = p_business)),
    (select since from bounds)
$$;

revoke execute on function public.stripe_dispute_rate(uuid, integer) from public, anon;
grant execute on function public.stripe_dispute_rate(uuid, integer) to authenticated;
