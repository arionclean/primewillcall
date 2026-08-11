-- Move a sale to a different kiosk (correct a mis-tagged sale).
--
-- Why this is not just an UPDATE: the Stripe webhook re-upserts every charge
-- whenever Stripe sends a later event for it (refund, dispute, update), and it
-- recomputes `source` from the charge metadata the tablet stamped. A plain edit
-- would silently revert to the wrong kiosk the next time that fires.
--
-- The fix keeps `source` as the single effective value, so every existing and
-- future reader (payments feed + totals, the Source filter, the per-kiosk caja
-- RLS policies) stays correct with no change: nothing has to remember to
-- coalesce an override column. A BEFORE UPDATE trigger pins `source` once a
-- sale has been moved, so any writer -- the webhook included -- is refused.
-- Only an explicit move, which also stamps source_moved_at, may change it.
--
-- The pre-move value is kept in *_original so a move stays auditable and
-- reversible.

-- 1. Card charges.
alter table public.stripe_transactions
  add column if not exists source_original text,
  add column if not exists source_moved_at timestamptz,
  add column if not exists source_moved_by uuid references public.staff(id) on delete set null;

comment on column public.stripe_transactions.source_original is
  'The kiosk/channel the charge arrived with, kept when a staffer moves the sale to another kiosk. Null means never moved.';
comment on column public.stripe_transactions.source_moved_at is
  'When the sale was last moved to a different kiosk. Non-null pins `source` against webhook overwrites.';

create or replace function public.pin_moved_transaction_source()
returns trigger
language plpgsql
as $$
begin
  -- Once moved, `source` is owned by the staffer who moved it. Only a write
  -- that also changes source_moved_at (i.e. the move action itself) may set it.
  if old.source_moved_at is not null
     and new.source_moved_at is not distinct from old.source_moved_at then
    new.source := old.source;
    new.source_original := old.source_original;
    new.source_moved_by := old.source_moved_by;
  end if;
  return new;
end;
$$;

drop trigger if exists pin_moved_source on public.stripe_transactions;
create trigger pin_moved_source
  before update on public.stripe_transactions
  for each row execute function public.pin_moved_transaction_source();

-- 2. Cash sales. Same idea; the kiosk lives in kiosk_slug here.
alter table public.cash_sales
  add column if not exists kiosk_slug_original text,
  add column if not exists source_moved_at timestamptz,
  add column if not exists source_moved_by uuid references public.staff(id) on delete set null;

comment on column public.cash_sales.kiosk_slug_original is
  'The kiosk the cash sale arrived with, kept when a staffer moves it to another kiosk. Null means never moved.';

create or replace function public.pin_moved_cash_source()
returns trigger
language plpgsql
as $$
begin
  if old.source_moved_at is not null
     and new.source_moved_at is not distinct from old.source_moved_at then
    new.kiosk_slug := old.kiosk_slug;
    new.kiosk_slug_original := old.kiosk_slug_original;
    new.source_moved_by := old.source_moved_by;
  end if;
  return new;
end;
$$;

drop trigger if exists pin_moved_source on public.cash_sales;
create trigger pin_moved_source
  before update on public.cash_sales
  for each row execute function public.pin_moved_cash_source();

-- 3. Surface the move in the payments feed so the row can show it and the
--    dialog can offer "put it back". Same body as 20260811120000 otherwise.
--    Dropped first: adding a column changes the return type, which
--    CREATE OR REPLACE cannot do.
drop function if exists public.payments_feed(
  timestamptz, timestamptz, uuid, text, text, integer, integer
);

create function public.payments_feed(
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
      0                       as amount_refunded,
      'usd'::text             as currency,
      'succeeded'::text       as status,
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

comment on function public.payments_feed(timestamptz, timestamptz, uuid, text, text, integer, integer) is
  'One page of the merged card + cash payments feed, ordered newest first, with the full-range row count in total_count. source_original is set when the sale was moved to another kiosk. SECURITY INVOKER: RLS scopes by business.';
