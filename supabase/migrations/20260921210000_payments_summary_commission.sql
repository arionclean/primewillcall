-- Payments header: subtract the desk commission from the cash figure.
--
-- The Cash card was gross of the commission staff take out of the till at
-- close, so the header read as "money we have" while several hundred dollars a
-- week had already left. The card now shows cash less its refunds AND less the
-- commission, with each deduction named underneath.
--
-- Commission is recorded once per kiosk per business day (kiosk_closings), not
-- per sale, so it can only follow the filters that are also per kiosk and per
-- day: the date range, the business, and a kiosk source. It cannot follow a text
-- search or a status filter, and it is not a card figure. In those cases the
-- function returns NULL, meaning "not attributable here", and the screen leaves
-- the line out rather than printing a number that does not belong to the rows
-- listed under it. NULL is not 0: a night with no commission really is 0.
--
-- Still SECURITY INVOKER, so a manager's totals stay scoped to their business by
-- the kiosk_closings policies, exactly like the sales they sit above.
CREATE OR REPLACE FUNCTION public.payments_summary(
  p_start    timestamptz,
  p_end      timestamptz,
  p_business uuid DEFAULT NULL,
  p_source   text DEFAULT NULL,
  p_q        text DEFAULT NULL,
  p_tender   text DEFAULT NULL,
  p_status   text DEFAULT NULL
)
RETURNS TABLE (
  card_gross    bigint,
  card_count    bigint,
  refunded      bigint,
  cash_total    bigint,
  cash_count    bigint,
  card_refunded bigint,
  cash_refunded bigint,
  commission    bigint
)
LANGUAGE sql
STABLE
AS $function$
  select
    coalesce(sum(f.amount) filter (where f.kind = 'card'), 0)::bigint,
    count(*) filter (where f.kind = 'card')::bigint,
    coalesce(sum(f.amount_refunded), 0)::bigint,
    -- A voided cash sale is on the list for the record, not in the drawer.
    coalesce(sum(f.amount) filter (where f.kind = 'cash' and f.voided_at is null), 0)::bigint,
    count(*) filter (where f.kind = 'cash' and f.voided_at is null)::bigint,
    coalesce(sum(f.amount_refunded) filter (where f.kind = 'card'), 0)::bigint,
    -- Cash handed back left the drawer (a voided sale never carries a refund).
    coalesce(sum(f.amount_refunded) filter (where f.kind = 'cash' and f.voided_at is null), 0)::bigint,
    case
      when coalesce(p_q, '') <> '' then null
      when p_status is not null then null
      when p_tender = 'card' then null
      else (
        select coalesce(sum(coalesce(kc.commission_cents_corrected, kc.commission_cents, 0)), 0)::bigint
        from public.kiosk_closings kc
        where kc.business_date between (p_start at time zone 'America/New_York')::date
                                   and (p_end   at time zone 'America/New_York')::date
          and (p_business is null or kc.business_id = p_business)
          and (p_source is null or kc.kiosk_slug = p_source)
      )
    end
  from public.payments_scope(
    p_start, p_end, p_business, p_source, p_q, p_tender, p_status
  ) f;
$function$;

COMMENT ON FUNCTION public.payments_summary(timestamptz, timestamptz, uuid, text, text, text, text) IS
  'Totals for the payments header over the same scope as the feed. `commission` is the desk commission for the range, or NULL when the active filters cannot attribute it.';
