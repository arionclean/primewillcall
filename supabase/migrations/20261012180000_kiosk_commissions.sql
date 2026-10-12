-- Desk commission: each seller's, worked out from their own sales.
--
-- Until now the desk typed one commission per kiosk per night at Close Out, and
-- the figure was whatever somebody decided. The rule is now fixed and per person:
-- a seller whose sales for the day reach $500 earns 10% of ALL of that day's
-- sales, rounded to whole dollars ($550 earns $55, $499 earns nothing).
--
-- The rule lives here and only here. The tablet's Commission button (through
-- kiosk-read) and the close (kiosk-closing-report) both read this function, so
-- what a seller sees during the day is what the close pays out.
--
--   * Sales are the kiosk's own ledger, cash_sales: cash and card alike, net of
--     refunds, voided and failed ones left out. The same rows the tablet's sales
--     screen lists and totals.
--   * Each kiosk counts on its own: the commission is paid from that kiosk's
--     cash, so a person who sells at two desks in a day is two lines.
--   * The day is the New York day, like every other kiosk figure.
--   * Who sold it is the PIN on the sale (cash_sales.employee_id). A sale with no
--     PIN earns nobody a commission and is left out.

CREATE OR REPLACE FUNCTION public.kiosk_commissions(
  p_kiosk_slug text,
  p_day        date
)
RETURNS TABLE (
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
      c.employee_id,
      -- A sale refunded in full no longer counts as one.
      count(*) FILTER (WHERE c.amount_cents > coalesce(c.amount_refunded_cents, 0)) AS sales,
      sum(c.amount_cents - coalesce(c.amount_refunded_cents, 0))::bigint AS sales_cents
    FROM public.cash_sales c
    WHERE c.kiosk_slug = p_kiosk_slug
      AND c.employee_id IS NOT NULL
      AND c.type IN ('cash', 'card')
      AND c.status = 'success'
      AND c.voided_at IS NULL
      AND c.created_at >= (p_day::timestamp AT TIME ZONE 'America/New_York')
      AND c.created_at <  ((p_day + 1)::timestamp AT TIME ZONE 'America/New_York')
    GROUP BY c.employee_id
  )
  SELECT
    p.employee_id,
    e.name,
    p.sales,
    p.sales_cents,
    -- 10% in whole dollars: cents / 1000 is the dollar figure, rounded half up.
    CASE WHEN p.sales_cents >= 50000 THEN round(p.sales_cents / 1000.0) * 100 ELSE 0 END::bigint
  FROM person p
  LEFT JOIN public.kiosk_employees e ON e.id = p.employee_id
  ORDER BY p.sales_cents DESC, e.name;
$$;

COMMENT ON FUNCTION public.kiosk_commissions(text, date) IS
  'Each seller''s commission at one kiosk for one New York day: 10% of the day''s sales (cash and card, net of refunds) in whole dollars, once they reach $500. Read by kiosk-read (the tablet''s Commission button) and kiosk-closing-report (the close).';

-- The tablet reaches it only through the kiosk edge functions, which run as the
-- service role. Nobody signs in to read it directly.
REVOKE ALL ON FUNCTION public.kiosk_commissions(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_commissions(text, date) TO service_role;
