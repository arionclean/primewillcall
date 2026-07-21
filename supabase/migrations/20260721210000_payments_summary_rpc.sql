-- Combined payments totals: Stripe card charges + kiosk cash sales.
--
-- Supersedes stripe_payments_summary for the /admin/payments page (the old
-- function stays until the app deploy that stops calling it). Cash comes from
-- cash_sales with type = 'cash' ONLY: the kiosk app also logs a 'card' sale
-- record there for each card payment, which already lands in
-- stripe_transactions via the webhook and would double count.
--
-- SECURITY INVOKER (default): RLS on both tables scopes managers to their
-- business. Optional filters mirror the page: p_source matches
-- stripe_transactions.source and cash_sales.kiosk_slug (kiosk1..kiosk4;
-- 'online' simply matches no cash rows).

create or replace function public.payments_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null
)
returns table (
  card_gross bigint,
  card_count bigint,
  refunded bigint,
  cash_total bigint,
  cash_count bigint
)
language sql
stable
as $$
  select
    (select coalesce(sum(t.amount), 0)
       from public.stripe_transactions t
      where t.object_type = 'charge'
        and t.stripe_created between p_start and p_end
        and (p_business is null or t.business_id = p_business)
        and (p_source is null or t.source = p_source)),
    (select count(*)
       from public.stripe_transactions t
      where t.object_type = 'charge'
        and t.stripe_created between p_start and p_end
        and (p_business is null or t.business_id = p_business)
        and (p_source is null or t.source = p_source)),
    (select coalesce(sum(t.amount_refunded), 0)
       from public.stripe_transactions t
      where t.object_type = 'charge'
        and t.stripe_created between p_start and p_end
        and (p_business is null or t.business_id = p_business)
        and (p_source is null or t.source = p_source)),
    (select coalesce(sum(c.amount_cents), 0)
       from public.cash_sales c
      where c.type = 'cash'
        and c.created_at between p_start and p_end
        and (p_business is null or c.business_id = p_business)
        and (p_source is null or c.kiosk_slug = p_source)),
    (select count(*)
       from public.cash_sales c
      where c.type = 'cash'
        and c.created_at between p_start and p_end
        and (p_business is null or c.business_id = p_business)
        and (p_source is null or c.kiosk_slug = p_source));
$$;

comment on function public.payments_summary(timestamptz, timestamptz, uuid, text) is
  'Card + cash totals for a date range with optional business/source filters, aggregated in the DB. SECURITY INVOKER: RLS scopes by business.';
