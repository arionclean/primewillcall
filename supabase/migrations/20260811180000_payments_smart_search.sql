-- Smart search on /admin/payments: tender (cash / card), status (refunded,
-- succeeded, ...) and a date, on top of the existing name / email / last4 /
-- sale-ref text match.
--
-- Structure change: the card + cash union now lives in ONE function,
-- payments_scope, and both payments_feed (a page of rows) and payments_summary
-- (the totals) read from it. Before, the two duplicated their filter clauses,
-- which is how the totals drifted from the list: the summary never applied the
-- search at all. Sharing the scope means every filter lands on both by
-- construction, so "Gross" always describes exactly the rows on screen.
--
-- All SECURITY INVOKER: RLS on the underlying tables still scopes by business.

-- Old signatures are dropped: the new parameters would otherwise create
-- ambiguous overloads.
drop function if exists public.payments_feed(
  timestamptz, timestamptz, uuid, text, text, integer, integer
);
drop function if exists public.payments_summary(
  timestamptz, timestamptz, uuid, text
);

create or replace function public.payments_scope(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_tender text default null,
  p_status text default null
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
  effective_status text,
  source text,
  source_original text,
  card_brand text,
  card_last4 text,
  stripe_id text,
  receipt_url text,
  customer_name text,
  customer_email text,
  booking_ref text,
  booking_id uuid,
  booking_starts_at timestamptz
)
language sql
stable
as $$
  select * from (
    select
      'card'::text            as kind,
      t.id                    as id,
      t.stripe_created        as occurred_at,
      t.business_id           as business_id,
      bz.name                 as business_name,
      t.amount                as amount,
      coalesce(t.amount_refunded, 0) as amount_refunded,
      t.currency              as currency,
      t.status                as status,
      -- What the row's badge shows, so a status search matches what staff read.
      case
        when t.status = 'disputed' then 'disputed'
        when coalesce(t.amount_refunded, 0) > 0
             and coalesce(t.amount_refunded, 0) >= t.amount then 'refunded'
        when coalesce(t.amount_refunded, 0) > 0 then 'partly_refunded'
        when t.status = 'succeeded' then 'succeeded'
        else coalesce(t.status, 'unknown')
      end                     as effective_status,
      t.source                as source,
      case when t.source_moved_at is not null then t.source_original end
                              as source_original,
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
      coalesce(c.amount_refunded_cents, 0) as amount_refunded,
      'usd'::text             as currency,
      'succeeded'::text       as status,
      case
        when coalesce(c.amount_refunded_cents, 0) > 0
             and coalesce(c.amount_refunded_cents, 0) >= coalesce(c.amount_cents, 0)
          then 'refunded'
        when coalesce(c.amount_refunded_cents, 0) > 0 then 'partly_refunded'
        else 'succeeded'
      end                     as effective_status,
      c.kiosk_slug            as source,
      case when c.source_moved_at is not null then c.kiosk_slug_original end
                              as source_original,
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
  ) f
  where (p_tender is null or f.kind = p_tender)
    -- "refunded" is read as "has a refund", so it also catches partial ones;
    -- "partly_refunded" narrows to just those.
    and (
      p_status is null
      or f.effective_status = p_status
      or (p_status = 'refunded' and f.effective_status = 'partly_refunded')
    );
$$;

comment on function public.payments_scope(timestamptz, timestamptz, uuid, text, text, text, text) is
  'The filtered card + cash sale set behind /admin/payments. Shared by payments_feed (rows) and payments_summary (totals) so the two can never disagree. SECURITY INVOKER: RLS scopes by business.';

create or replace function public.payments_feed(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_tender text default null,
  p_status text default null,
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
  source_original text,
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
    f.source_original,
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
  from public.payments_scope(
    p_start, p_end, p_business, p_source, p_q, p_tender, p_status
  ) f
  order by f.occurred_at desc, f.id
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

comment on function public.payments_feed(timestamptz, timestamptz, uuid, text, text, text, text, integer, integer) is
  'One page of the payments feed, newest first, with the whole-scope row count in total_count. SECURITY INVOKER: RLS scopes by business.';

create or replace function public.payments_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_tender text default null,
  p_status text default null
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
    coalesce(sum(f.amount) filter (where f.kind = 'card'), 0)::bigint,
    count(*) filter (where f.kind = 'card')::bigint,
    coalesce(sum(f.amount_refunded), 0)::bigint,
    coalesce(sum(f.amount) filter (where f.kind = 'cash'), 0)::bigint,
    count(*) filter (where f.kind = 'cash')::bigint
  from public.payments_scope(
    p_start, p_end, p_business, p_source, p_q, p_tender, p_status
  ) f;
$$;

comment on function public.payments_summary(timestamptz, timestamptz, uuid, text, text, text, text) is
  'Card + cash totals over the same scope the feed lists, aggregated in the DB. Card and cash are gross; refunded covers both tenders. SECURITY INVOKER: RLS scopes by business.';
