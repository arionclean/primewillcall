-- Cash reconciliation: what the desk counted at close against what the system recorded.
--
-- The owner's question at the end of a night is "is the money in my hand the
-- money the system says we took". Two records answer it and neither one alone is
-- enough: kiosk_closings.cash_cents is what the tablet counted, cash_sales is
-- what was actually rung up. This function puts them side by side, one row per
-- kiosk per business day, and hands back the difference.
--
-- Why a FULL OUTER JOIN and not a plain lookup off the closings: a night that
-- sold cash and was never closed is the worst case, not the absent one, so it has
-- to appear as a row with no close rather than vanish. The reverse (a close with
-- no sales) is equally worth seeing.
--
-- Why in the database: the diff is an aggregate over cash_sales, which a month of
-- kiosk trading pushes past the 1000-row read cap. The function returns at most
-- one row per kiosk per day.
--
-- SECURITY INVOKER, so RLS scopes it: the owner sees every kiosk, a manager only
-- their own business's closings and cash sales, and check_in reaches neither.

CREATE OR REPLACE FUNCTION public.kiosk_cash_reconciliation(
  p_from     date,
  p_to       date,
  p_business uuid DEFAULT NULL
)
RETURNS TABLE (
  closing_id                 uuid,
  business_date              date,
  kiosk_slug                 text,
  business_id                uuid,
  business_name              text,
  closed                     boolean,
  closed_by_name             text,
  closed_at                  timestamptz,
  counted_cash_cents         integer,
  system_cash_cents          bigint,
  system_cash_count          bigint,
  commission_cents           integer,
  commission_cents_corrected integer,
  effective_commission_cents integer,
  correction_note            text,
  corrected_at               timestamptz,
  to_collect_cents           integer,
  diff_cents                 bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH sys AS (
    -- What the system recorded. Cash only (cash_sales carries the tablet's card
    -- sales too), net of refunds, voided rows excluded: a voided row is listed
    -- everywhere else but never counted.
    SELECT
      cs.kiosk_slug,
      (cs.created_at AT TIME ZONE 'America/New_York')::date AS business_date,
      SUM(cs.amount_cents - COALESCE(cs.amount_refunded_cents, 0))::bigint AS cents,
      COUNT(*)::bigint AS n
    FROM public.cash_sales cs
    WHERE cs.type = 'cash'
      AND cs.voided_at IS NULL
      AND cs.kiosk_slug IS NOT NULL
      AND (cs.created_at AT TIME ZONE 'America/New_York')::date BETWEEN p_from AND p_to
    GROUP BY 1, 2
  ),
  closings AS (
    SELECT * FROM public.kiosk_closings kc
    WHERE kc.business_date BETWEEN p_from AND p_to
  )
  SELECT
    c.id,
    COALESCE(c.business_date, s.business_date),
    COALESCE(c.kiosk_slug, s.kiosk_slug),
    COALESCE(c.business_id, k.business_id),
    b.name,
    c.id IS NOT NULL,
    c.closed_by_name,
    c.closed_at,
    c.cash_cents,
    COALESCE(s.cents, 0),
    COALESCE(s.n, 0),
    c.commission_cents,
    c.commission_cents_corrected,
    COALESCE(c.commission_cents_corrected, c.commission_cents, 0),
    c.correction_note,
    c.corrected_at,
    c.total_cash_cents,
    COALESCE(s.cents, 0) - COALESCE(c.cash_cents, 0)
  FROM closings c
  FULL OUTER JOIN sys s
    ON s.kiosk_slug = c.kiosk_slug
   AND s.business_date = c.business_date
  LEFT JOIN public.kiosks k
    ON k.slug = COALESCE(c.kiosk_slug, s.kiosk_slug)
  LEFT JOIN public.businesses b
    ON b.id = COALESCE(c.business_id, k.business_id)
  WHERE p_business IS NULL
     OR COALESCE(c.business_id, k.business_id) = p_business
  ORDER BY 2 DESC, 3;
$$;

COMMENT ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) IS
  'One row per kiosk per business day: cash counted at close vs cash the system recorded, with the commission and the difference. Feeds /admin/payments/cash.';

REVOKE ALL ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) TO authenticated;
