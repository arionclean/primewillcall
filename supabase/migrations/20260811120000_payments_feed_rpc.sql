-- Paginated payments feed: Stripe card charges + kiosk cash sales, merged,
-- sorted and paged in the database.
--
-- Replaces the app-side "fetch 200 of each, merge, sort, slice" approach on
-- /admin/payments, which could not paginate correctly (an offset applied to
-- each source separately does not offset the merged list) and silently hid
-- older sales. The union, the ordering, the LIMIT/OFFSET and the total row
-- count all happen here, so the page reads exactly one screen of rows.
--
-- Cash comes from cash_sales with type = 'cash' ONLY: the kiosk app also logs
-- a 'card' row there for each card payment, which already lands in
-- stripe_transactions via the webhook and would double count. Cash rows carry
-- the sale's KS code in booking_ref, which matches bookings.legacy_id: that is
-- how a cash sale resolves to a customer name and a booking link.
--
-- SECURITY INVOKER (default): RLS on every table scopes managers to their own
-- business. Optional filters mirror the page: p_source matches
-- stripe_transactions.source and cash_sales.kiosk_slug ('online' simply
-- matches no cash rows), p_q searches name / email / last4 / sale ref.

create or replace function public.payments_feed(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  kind text,
  id uuid,
  occurred_at timestamptz,
  business_id uuid,
  business_name text,
  amount integer,
  amount_refunded integer,
  currency text,
  status text,
  source text,
  card_brand text,
  card_last4 text,
  stripe_id text,
  receipt_url text,
  customer_name text,
  customer_email text,
  booking_ref text,
  booking_id uuid,
  booking_starts_at timestamptz,
  total_count bigint
)
language sql
stable
as $$
  with feed as (
    select
      'card'::text            as kind,
      t.id                    as id,
      t.stripe_created        as occurred_at,
      t.business_id           as business_id,
      bz.name                 as business_name,
      t.amount                as amount,
      t.amount_refunded       as amount_refunded,
      t.currency              as currency,
      t.status                as status,
      t.source                as source,
      t.card_brand            as card_brand,
      t.card_last4            as card_last4,
      t.stripe_id             as stripe_id,
      t.receipt_url           as receipt_url,
      t.customer_name         as customer_name,
      t.customer_email        as customer_email,
      t.booking_ref           as booking_ref,
      t.booking_id            as booking_id,
      bk.starts_at            as booking_starts_at
    from public.stripe_transactions t
    left join public.businesses bz on bz.id = t.business_id
    left join public.bookings   bk on bk.id = t.booking_id
    where t.object_type = 'charge'
      and t.stripe_created between p_start and p_end
      and (p_business is null or t.business_id = p_business)
      and (p_source is null or t.source = p_source)
      and (
        p_q is null
        or t.customer_name  ilike '%' || p_q || '%'
        or t.customer_email ilike '%' || p_q || '%'
        or t.card_last4     ilike '%' || p_q || '%'
        or t.booking_ref    ilike '%' || p_q || '%'
      )

    union all

    select
      'cash'::text            as kind,
      c.id                    as id,
      c.created_at            as occurred_at,
      c.business_id           as business_id,
      bz.name                 as business_name,
      c.amount_cents          as amount,
      0                       as amount_refunded,
      'usd'::text             as currency,
      'succeeded'::text       as status,
      c.kiosk_slug            as source,
      null::text              as card_brand,
      null::text              as card_last4,
      null::text              as stripe_id,
      null::text              as receipt_url,
      nullif(btrim(cu.full_name), '') as customer_name,
      null::text              as customer_email,
      c.booking_ref           as booking_ref,
      bk.id                   as booking_id,
      bk.starts_at            as booking_starts_at
    from public.cash_sales c
    left join public.businesses bz on bz.id = c.business_id
    left join public.bookings   bk on bk.legacy_id = c.booking_ref
    left join public.customers  cu on cu.id = bk.customer_id
    where c.type = 'cash'
      and c.created_at between p_start and p_end
      and (p_business is null or c.business_id = p_business)
      and (p_source is null or c.kiosk_slug = p_source)
      and (
        p_q is null
        or c.booking_ref  ilike '%' || p_q || '%'
        or cu.full_name   ilike '%' || p_q || '%'
      )
  )
  select
    f.kind,
    f.id,
    f.occurred_at,
    f.business_id,
    f.business_name,
    f.amount,
    f.amount_refunded,
    f.currency,
    f.status,
    f.source,
    f.card_brand,
    f.card_last4,
    f.stripe_id,
    f.receipt_url,
    f.customer_name,
    f.customer_email,
    f.booking_ref,
    f.booking_id,
    f.booking_starts_at,
    count(*) over () as total_count
  from feed f
  order by f.occurred_at desc, f.id
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

comment on function public.payments_feed(timestamptz, timestamptz, uuid, text, text, integer, integer) is
  'One page of the merged card + cash payments feed, ordered newest first, with the full-range row count in total_count. SECURITY INVOKER: RLS scopes by business.';
