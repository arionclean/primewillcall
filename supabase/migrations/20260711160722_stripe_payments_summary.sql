-- Aggregated payments summary for the /admin/payments screen. Pushes SUM into
-- the DB (never fetch-all-and-sum-in-JS; the 1000-row read cap would truncate).
-- SECURITY INVOKER (default) so stripe_transactions RLS still scopes the numbers
-- by business: owner sees all, business_manager sees only their own business.
create or replace function public.stripe_payments_summary(
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  gross bigint,
  net bigint,
  stripe_fees bigint,
  application_fees bigint,
  refunded bigint,
  txn_count bigint
)
language sql
stable
set search_path to 'public'
as $$
  select
    coalesce(sum(amount), 0)::bigint          as gross,
    coalesce(sum(net), 0)::bigint             as net,
    coalesce(sum(stripe_fee), 0)::bigint      as stripe_fees,
    coalesce(sum(application_fee), 0)::bigint as application_fees,
    coalesce(sum(amount_refunded), 0)::bigint as refunded,
    count(*)::bigint                          as txn_count
  from stripe_transactions
  where object_type = 'charge'
    and coalesce(status, '') <> 'failed'
    and stripe_created >= p_start
    and stripe_created <  p_end
$$;

comment on function public.stripe_payments_summary(timestamptz, timestamptz) is
  'Payments totals (gross/net/fees/refunded/count) for a date range, aggregated in the DB. SECURITY INVOKER: RLS on stripe_transactions scopes by business.';
