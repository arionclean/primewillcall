-- ── /admin/payments: each summary card shows what was kept ─────────────────────
-- The Card and Cash cards showed the amount taken, and every refund sat in one
-- separate Refunded card, so a desk's cash read $400 on a day a $105 cash sale
-- was handed back. The page now shows each tender less its own refunds, with the
-- refund under it, so payments_summary splits `refunded` by tender:
-- card_refunded and cash_refunded. `refunded` stays (their sum) so the page
-- already deployed keeps working until the new one is live.
-- A return type cannot change under CREATE OR REPLACE, so it is dropped and
-- recreated with the same signature and grants (20260907240000 is the base).

drop function if exists public.payments_summary(
  timestamptz, timestamptz, uuid, text, text, text, text
);

create function public.payments_summary(
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
  cash_count bigint,
  card_refunded bigint,
  cash_refunded bigint
)
language sql
stable
as $$
  select
    coalesce(sum(f.amount) filter (where f.kind = 'card'), 0)::bigint,
    count(*) filter (where f.kind = 'card')::bigint,
    coalesce(sum(f.amount_refunded), 0)::bigint,
    -- A voided cash sale is on the list for the record, not in the drawer.
    coalesce(sum(f.amount) filter (where f.kind = 'cash' and f.voided_at is null), 0)::bigint,
    count(*) filter (where f.kind = 'cash' and f.voided_at is null)::bigint,
    coalesce(sum(f.amount_refunded) filter (where f.kind = 'card'), 0)::bigint,
    -- Cash handed back left the drawer (a voided sale never carries a refund).
    coalesce(sum(f.amount_refunded) filter (where f.kind = 'cash' and f.voided_at is null), 0)::bigint
  from public.payments_scope(
    p_start, p_end, p_business, p_source, p_q, p_tender, p_status
  ) f;
$$;

comment on function public.payments_summary(timestamptz, timestamptz, uuid, text, text, text, text) is
  'Card + cash totals over the same scope the feed lists, aggregated in the DB. card_gross and cash_total are what was taken; card_refunded and cash_refunded are what went back, so the page shows each less its refunds (refunded is their sum). Voided cash sales are left out. SECURITY INVOKER: RLS scopes by business.';

grant execute on function public.payments_summary(timestamptz, timestamptz, uuid, text, text, text, text)
  to anon, authenticated, service_role;
