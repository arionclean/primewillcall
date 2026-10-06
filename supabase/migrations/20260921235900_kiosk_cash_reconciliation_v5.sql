-- Cash close, as it actually runs: the record of what production holds.
--
-- Already applied. Production ran this on 2026-09-21 as migration version
-- 20260921222409 (kiosk_cash_reconciliation_v5_card_gross), after two versions
-- that never reached the repo (v4 added the sales that came in after the close,
-- v5 the card total before refunds). The SQL below is copied verbatim from
-- supabase_migrations.schema_migrations, so the repo now matches what the
-- /admin/payments/cash screen reads. It supersedes 20260921230000 (v3).
--
-- What changed since v3:
--   after_close_count / after_close_cents: sales rung up after the night was
--     closed, the tell for a close made too early.
--   system_card_gross_cents: card takings before refunds. The close report is
--     a point-in-time gross figure, so a card refunded later on the web (which
--     the tablet never hears about) is not a difference the desk got wrong.

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
  system_card_gross_cents    bigint,
  system_card_count          bigint,
  reported_card_cents        integer,
  after_close_count          bigint,
  after_close_cents          bigint,
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
  WITH closings AS (
    SELECT * FROM public.kiosk_closings kc
    WHERE kc.business_date BETWEEN p_from AND p_to
  ),
  sales AS (
    SELECT
      cs.kiosk_slug,
      (cs.created_at AT TIME ZONE 'America/New_York')::date AS business_date,
      cs.type,
      cs.amount_cents,
      cs.amount_cents - COALESCE(cs.amount_refunded_cents, 0) AS net_cents,
      cs.created_at
    FROM public.cash_sales cs
    WHERE cs.voided_at IS NULL
      AND cs.kiosk_slug IS NOT NULL
      AND cs.type IN ('cash', 'card')
      AND (cs.created_at AT TIME ZONE 'America/New_York')::date BETWEEN p_from AND p_to
  ),
  sys AS (
    SELECT
      s.kiosk_slug,
      s.business_date,
      COALESCE(SUM(s.net_cents) FILTER (WHERE s.type = 'cash'), 0)::bigint AS cash_cents,
      COUNT(*) FILTER (WHERE s.type = 'cash')::bigint AS cash_n,
      COALESCE(SUM(s.net_cents) FILTER (WHERE s.type = 'card'), 0)::bigint AS card_cents,
      -- Gross as well as net, because the close report is a point-in-time gross
      -- figure: a card refunded later (on the web, where the tablet never hears
      -- about it) is not a difference the desk got wrong.
      COALESCE(SUM(s.amount_cents) FILTER (WHERE s.type = 'card'), 0)::bigint AS card_gross,
      COUNT(*) FILTER (WHERE s.type = 'card')::bigint AS card_n,
      COUNT(*) FILTER (WHERE c.closed_at IS NOT NULL AND s.created_at > c.closed_at)::bigint AS after_n,
      COALESCE(SUM(s.net_cents)
        FILTER (WHERE c.closed_at IS NOT NULL AND s.created_at > c.closed_at), 0)::bigint AS after_cents
    FROM sales s
    LEFT JOIN closings c
      ON c.kiosk_slug = s.kiosk_slug
     AND c.business_date = s.business_date
    GROUP BY 1, 2
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
    COALESCE(s.card_gross, 0),
    COALESCE(s.card_n, 0),
    CASE WHEN c.entered_manually THEN NULL ELSE c.card_cents END,
    COALESCE(s.after_n, 0),
    COALESCE(s.after_cents, 0),
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

REVOKE ALL ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.kiosk_cash_reconciliation(date, date, uuid) TO authenticated;
