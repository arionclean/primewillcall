-- Cash close: show the whole night, not only its cash.
--
-- The screen answered "does the cash add up" but not "how did this kiosk do",
-- so the owner had to leave it to see the card takings that make up the rest of
-- the day. Both tenders now come out of one pass over cash_sales (which holds
-- the tablet's card sales as well), and the desk's own reported card figure
-- comes along so a card count can be checked the same way the cash one is.
--
-- The reported card figure is NULL on a hand-entered night: nothing was
-- reported there, and a zero would read as "the desk took no cards".
DROP FUNCTION IF EXISTS public.kiosk_cash_reconciliation(date, date, uuid);

CREATE FUNCTION public.kiosk_cash_reconciliation(
  p_from     date,
  p_to       date,
  p_business uuid DEFAULT NULL
)
RETURNS TABLE (
  closing_id                 uuid,
  business_date              date,
  kiosk_id                   uuid,
  kiosk_slug                 text,
  business_id                uuid,
  business_name              text,
  closed                     boolean,
  entered_manually           boolean,
  closed_by_name             text,
  closed_at                  timestamptz,
  counted_cash_cents         integer,
  counted_cash_cents_corrected integer,
  effective_counted_cash_cents integer,
  system_cash_cents          bigint,
  system_cash_count          bigint,
  system_card_cents          bigint,
  system_card_count          bigint,
  reported_card_cents        integer,
  commission_cents           integer,
  commission_cents_corrected integer,
  effective_commission_cents integer,
  correction_note            text,
  corrected_at               timestamptz,
  reviewed_at                timestamptz,
  reviewed_by_name           text,
  to_collect_cents           integer,
  diff_cents                 bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH sys AS (
    -- Both tenders in one pass: cash_sales carries the tablet's card sales too.
    -- Net of refunds, voided rows skipped: a voided sale is listed for the
    -- record everywhere else, never counted.
    SELECT
      cs.kiosk_slug,
      (cs.created_at AT TIME ZONE 'America/New_York')::date AS business_date,
      COALESCE(SUM(cs.amount_cents - COALESCE(cs.amount_refunded_cents, 0))
        FILTER (WHERE cs.type = 'cash'), 0)::bigint AS cash_cents,
      COUNT(*) FILTER (WHERE cs.type = 'cash')::bigint AS cash_n,
      COALESCE(SUM(cs.amount_cents - COALESCE(cs.amount_refunded_cents, 0))
        FILTER (WHERE cs.type = 'card'), 0)::bigint AS card_cents,
      COUNT(*) FILTER (WHERE cs.type = 'card')::bigint AS card_n
    FROM public.cash_sales cs
    WHERE cs.voided_at IS NULL
      AND cs.kiosk_slug IS NOT NULL
      AND cs.type IN ('cash', 'card')
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
    COALESCE(c.kiosk_id, k.id),
    COALESCE(c.kiosk_slug, s.kiosk_slug),
    COALESCE(c.business_id, k.business_id),
    b.name,
    c.id IS NOT NULL,
    COALESCE(c.entered_manually, false),
    c.closed_by_name,
    c.closed_at,
    c.cash_cents,
    c.cash_cents_corrected,
    COALESCE(c.cash_cents_corrected, c.cash_cents),
    COALESCE(s.cash_cents, 0),
    COALESCE(s.cash_n, 0),
    COALESCE(s.card_cents, 0),
    COALESCE(s.card_n, 0),
    CASE WHEN c.entered_manually THEN NULL ELSE c.card_cents END,
    c.commission_cents,
    c.commission_cents_corrected,
    COALESCE(c.commission_cents_corrected, c.commission_cents, 0),
    c.correction_note,
    c.corrected_at,
    c.reviewed_at,
    COALESCE(rb.full_name, rb.email),
    c.total_cash_cents,
    COALESCE(s.cash_cents, 0) - COALESCE(c.cash_cents_corrected, c.cash_cents, 0)
  FROM closings c
  FULL OUTER JOIN sys s
    ON s.kiosk_slug = c.kiosk_slug
   AND s.business_date = c.business_date
  LEFT JOIN public.kiosks k
    ON k.slug = COALESCE(c.kiosk_slug, s.kiosk_slug)
  LEFT JOIN public.businesses b
    ON b.id = COALESCE(c.business_id, k.business_id)
  LEFT JOIN public.staff rb
    ON rb.id = c.reviewed_by
  WHERE p_business IS NULL
     OR COALESCE(c.business_id, k.business_id) = p_business
  ORDER BY 2 DESC, 4;
$$;

COMMENT ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) IS
  'One row per kiosk per business day: the day''s card and cash takings, what the desk counted, the commission, the cash left to collect and the owner sign-off. Feeds /admin/payments/cash.';

REVOKE ALL ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) TO authenticated;
