-- Desk commission: each seller's, worked out from their own sales.
--
-- Until now the desk typed one commission per kiosk per night at Close Out, and
-- the figure was whatever somebody decided. The rule is now fixed and per person:
-- a seller whose sales at a kiosk for the day reach $500 earns 10% of ALL of that
-- day's sales, rounded to whole dollars ($550 earns $55, $499 earns nothing).
--
-- seller_commissions() is the rule, and the only place it lives. Everything else
-- reads it:
--   * the tablet's Commission button (kiosk-read) and the close
--     (kiosk-closing-report), one kiosk and one day at a time, as the service role;
--   * Team -> Sales on the web (team_commissions below), each person's total over
--     a range, owner only.
--
-- What counts:
--   * Sales are the kiosk's own ledger, cash_sales: cash and card alike, net of
--     refunds, voided and failed ones left out. The same rows the tablet's sales
--     screen lists and totals.
--   * Each kiosk counts on its own: the commission is paid from that kiosk's
--     cash, so a person who sells at two desks in a day is two lines.
--   * The day is the New York day, like every other kiosk figure.
--   * Who sold it is the PIN on the sale (cash_sales.employee_id). A sale with no
--     PIN earns nobody a commission and is left out.

-- ---------------------------------------------------------------------------
-- The rule: one row per seller, per kiosk, per New York day in the range.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seller_commissions(
  p_from       date,
  p_to         date,
  p_kiosk_slug text DEFAULT NULL
)
RETURNS TABLE (
  business_date    date,
  kiosk_slug       text,
  business_id      uuid,
  employee_id      uuid,
  employee_name    text,
  sales            bigint,
  sales_cents      bigint,
  commission_cents bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH person AS (
    SELECT
      (c.created_at AT TIME ZONE 'America/New_York')::date AS business_date,
      c.kiosk_slug,
      c.employee_id,
      -- A sale refunded in full no longer counts as one.
      count(*) FILTER (WHERE c.amount_cents > coalesce(c.amount_refunded_cents, 0)) AS sales,
      sum(c.amount_cents - coalesce(c.amount_refunded_cents, 0))::bigint AS sales_cents
    FROM public.cash_sales c
    WHERE c.kiosk_slug IS NOT NULL
      AND (p_kiosk_slug IS NULL OR c.kiosk_slug = p_kiosk_slug)
      AND c.employee_id IS NOT NULL
      AND c.type IN ('cash', 'card')
      AND c.status = 'success'
      AND c.voided_at IS NULL
      AND c.created_at >= (p_from::timestamp AT TIME ZONE 'America/New_York')
      AND c.created_at <  ((p_to + 1)::timestamp AT TIME ZONE 'America/New_York')
    GROUP BY 1, 2, 3
  )
  SELECT
    p.business_date,
    p.kiosk_slug,
    k.business_id,
    p.employee_id,
    e.name,
    p.sales,
    p.sales_cents,
    -- 10% in whole dollars: cents / 1000 is the dollar figure, rounded half up.
    CASE WHEN p.sales_cents >= 50000 THEN round(p.sales_cents / 1000.0) * 100 ELSE 0 END::bigint
  FROM person p
  LEFT JOIN public.kiosks k ON k.slug = p.kiosk_slug
  LEFT JOIN public.kiosk_employees e ON e.id = p.employee_id
  ORDER BY p.business_date, p.kiosk_slug, p.sales_cents DESC, e.name;
$$;

COMMENT ON FUNCTION public.seller_commissions(date, date, text) IS
  'The desk commission rule: per seller, per kiosk, per New York day, 10% of the day''s sales (cash_sales, cash and card, net of refunds) in whole dollars once they reach $500. Read by kiosk-read, kiosk-closing-report and team_commissions.';

-- SECURITY INVOKER (the default), so cash_sales RLS decides what a caller sees.
-- The tablet path runs as the service role and sees its kiosk's day whole. On the
-- web only the owner sees every sale of a kiosk-day, which the rule needs, so
-- the owner's team_commissions is its one web reader.
REVOKE ALL ON FUNCTION public.seller_commissions(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_commissions(date, date, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Team -> Sales: each person's commission over a range, summed in the database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_commissions(
  p_from     date,
  p_to       date,
  p_business uuid DEFAULT NULL
)
RETURNS TABLE (
  employee_id      uuid,
  employee_name    text,
  commission_cents bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    s.employee_id,
    max(s.employee_name),
    sum(s.commission_cents)::bigint
  FROM public.seller_commissions(p_from, p_to) s
  WHERE (p_business IS NULL OR s.business_id = p_business)
    -- Owner only, like team_sales beside it: a manager can read part of the
    -- ledger, so no policy alone would stop them.
    AND EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner')
  GROUP BY s.employee_id;
$$;

COMMENT ON FUNCTION public.team_commissions(date, date, uuid) IS
  'Each person''s desk commission over a range of New York days, for Team -> Sales: the sum of seller_commissions. A business filter keeps the kiosks of that business. Owner only: anyone else gets no rows.';

REVOKE ALL ON FUNCTION public.team_commissions(date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_commissions(date, date, uuid) TO authenticated;
