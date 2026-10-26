-- Desk commission, set per kiosk.
--
-- The rule in seller_commissions() was one rule for every desk: 10% of a seller's
-- day once it reaches $500, in whole dollars. kiosk1 (Key West) has never paid
-- that way. It pays by milestones: from $1,000 a seller earns 10% of the last $500
-- milestone reached. $1,000 earns $100, $1,385 still $100, $1,500 earns $150,
-- $2,689 earns $250. Checked against every kiosk1 night from 2026-09-12 to
-- 2026-10-25: it is what the desk paid on all of them but one (2026-10-02).
--
-- So the two numbers that differ between desks now live on the kiosk:
--   * commission_from_cents: what a seller's day must reach. $500 by default.
--   * commission_step_cents: when set, the sales are rounded DOWN to this step
--     before the 10% (kiosk1: $500, the milestones). NULL is the old rule, 10% of
--     the exact sales rounded to the whole dollar.
--
-- seller_commissions() is still the one place the rule is worked out; it now reads
-- them. Every reader follows without a change: the tablet's Commission button and
-- the close (kiosk-read, kiosk-closing-report) and Team -> Sales (team_commissions).
-- Team -> Sales works the past out again from the sales, so kiosk1's earlier days
-- now read as kiosk1 paid them.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.kiosks
  ADD COLUMN commission_from_cents integer NOT NULL DEFAULT 50000
    CHECK (commission_from_cents >= 0),
  ADD COLUMN commission_step_cents integer
    CHECK (commission_step_cents IS NULL OR commission_step_cents > 0);

COMMENT ON COLUMN public.kiosks.commission_from_cents IS
  'Desk commission: what a seller''s sales at this kiosk for the day must reach before they earn anything. Read by seller_commissions().';
COMMENT ON COLUMN public.kiosks.commission_step_cents IS
  'Desk commission milestones: when set, the day''s sales are rounded down to this step before the 10% (50000 = $1,000 earns $100, $1,500 earns $150). NULL is 10% of the exact sales in whole dollars. Read by seller_commissions().';

UPDATE public.kiosks
   SET commission_from_cents = 100000,
       commission_step_cents = 50000
 WHERE slug = 'kiosk1';

-- Same signature, columns and readers as 20261013003535_seller_commissions.sql; only
-- the commission line reads the kiosk now.
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
    CASE
      -- Below the kiosk's starting point nothing is earned. A sale on a kiosk with
      -- no row keeps the $500 everybody had.
      WHEN p.sales_cents < coalesce(k.commission_from_cents, 50000) THEN 0
      -- Milestones: 10% of the sales rounded down to the step ($1,385 -> $1,000 -> $100).
      WHEN k.commission_step_cents IS NOT NULL
        THEN floor(p.sales_cents::numeric / k.commission_step_cents) * k.commission_step_cents / 10
      -- 10% in whole dollars: cents / 1000 is the dollar figure, rounded half up.
      ELSE round(p.sales_cents / 1000.0) * 100
    END::bigint
  FROM person p
  LEFT JOIN public.kiosks k ON k.slug = p.kiosk_slug
  LEFT JOIN public.kiosk_employees e ON e.id = p.employee_id
  ORDER BY p.business_date, p.kiosk_slug, p.sales_cents DESC, e.name;
$$;

COMMENT ON FUNCTION public.seller_commissions(date, date, text) IS
  'The desk commission rule: per seller, per kiosk, per New York day, 10% of the day''s sales (cash_sales, cash and card, net of refunds) once they reach the kiosk''s commission_from_cents, in whole dollars, or of the sales rounded down to commission_step_cents when the kiosk pays by milestones. Read by kiosk-read, kiosk-closing-report and team_commissions.';
