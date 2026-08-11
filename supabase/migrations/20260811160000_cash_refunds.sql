-- Refund a cash sale, and require the refund passcode to move a sale.
--
-- A cash refund has no Stripe call to make: the money comes back out of the
-- drawer by hand. So it is a ledger entry, recorded on the sale itself the same
-- way card refunds are tracked (a running refunded total, so partial refunds
-- work and a second refund cannot push past the sale amount).
--
-- The check constraint is the last line of defence, matching the card path:
-- the client checks the remaining balance, the server action re-checks it from
-- the row, and this refuses the write outright if either is ever bypassed.

alter table public.cash_sales
  add column if not exists amount_refunded_cents integer not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references public.staff(id) on delete set null;

comment on column public.cash_sales.amount_refunded_cents is
  'Cash handed back to the customer, in cents. Never exceeds amount_cents (enforced by cash_sales_refund_within_amount).';

alter table public.cash_sales
  drop constraint if exists cash_sales_refund_within_amount;
alter table public.cash_sales
  add constraint cash_sales_refund_within_amount
  check (
    amount_refunded_cents >= 0
    and (amount_cents is null or amount_refunded_cents <= amount_cents)
  );

-- Totals: cash stays GROSS (matching card_gross, which is also gross of
-- refunds) and the refunded card now covers both tenders.
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
        and (p_source is null or t.source = p_source))
    +
    (select coalesce(sum(c.amount_refunded_cents), 0)
       from public.cash_sales c
      where c.type = 'cash'
        and c.created_at between p_start and p_end
        and (p_business is null or c.business_id = p_business)
        and (p_source is null or c.kiosk_slug = p_source)),
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
  'Card + cash totals for a date range with optional business/source filters, aggregated in the DB. Cash and card are gross; refunded covers both tenders. SECURITY INVOKER: RLS scopes by business.';

-- Feed: carry the cash refund total and status so a refunded cash sale reads
-- the same as a refunded card charge.
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
      case
        when coalesce(c.amount_refunded_cents, 0) >= coalesce(c.amount_cents, 0)
             and coalesce(c.amount_refunded_cents, 0) > 0
        then 'refunded'
        else 'succeeded'
      end                     as status,
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
  from feed f
  order by f.occurred_at desc, f.id
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;
