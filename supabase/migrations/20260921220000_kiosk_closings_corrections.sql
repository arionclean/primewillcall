-- Cash close, part two: correct the count, enter a missing night, sign it off.
--
-- The first version of this table could only fix a commission. Three things the
-- owner actually needs were missing:
--
--   * the counted cash is typed by a person at the end of a long day, so it can
--     be wrong exactly as often as the commission. It gets the same treatment:
--     the reported figure is never edited, a correction sits beside it.
--   * a night nobody closed had no row at all, so there was nothing to fix. The
--     owner can now enter one by hand. Such a row has NULL reported figures
--     (nothing was reported) and carries the owner's numbers in the correction
--     columns, which is why cash_cents becomes nullable here.
--   * "Matches" is arithmetic, not a decision. A $2 difference the owner accepts
--     stayed red forever. reviewed_at is the human answer, and it outranks the
--     arithmetic on screen.
--
-- Any later tablet report that genuinely CHANGES a reported figure drops the
-- correction and the sign-off that were based on the old one. A reprint of the
-- same numbers changes nothing, and a first report arriving for a hand-entered
-- night leaves the owner's figures alone to be compared rather than erased.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.kiosk_closings
  ADD COLUMN IF NOT EXISTS cash_cents_corrected integer
    CHECK (cash_cents_corrected IS NULL OR cash_cents_corrected >= 0),
  ADD COLUMN IF NOT EXISTS entered_manually boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.staff(id) ON DELETE SET NULL;

-- A hand-entered night has no reported count, and NULL says that plainly where
-- a 0 would read as "the desk counted nothing".
ALTER TABLE public.kiosk_closings ALTER COLUMN cash_cents DROP NOT NULL;
ALTER TABLE public.kiosk_closings ALTER COLUMN cash_cents DROP DEFAULT;

COMMENT ON COLUMN public.kiosk_closings.cash_cents IS
  'The cash the tablet reported at close. NULL when the night was entered by hand and nothing was reported.';
COMMENT ON COLUMN public.kiosk_closings.cash_cents_corrected IS
  'An owner correction to the counted cash, or the whole figure on a hand-entered night. NULL means the reported count stands.';
COMMENT ON COLUMN public.kiosk_closings.entered_manually IS
  'True when the owner created this night by hand because no tablet ever closed it.';
COMMENT ON COLUMN public.kiosk_closings.reviewed_at IS
  'When the owner signed this night off. A difference that is reviewed is settled, whatever the arithmetic says.';

-- ---------------------------------------------------------------------------
-- The money to collect now follows the corrected count too.
-- A generated column cannot be altered in place, so it is rebuilt.
-- ---------------------------------------------------------------------------
ALTER TABLE public.kiosk_closings DROP COLUMN IF EXISTS total_cash_cents;
ALTER TABLE public.kiosk_closings
  ADD COLUMN total_cash_cents integer GENERATED ALWAYS AS (
    COALESCE(cash_cents_corrected, cash_cents, 0)
    - COALESCE(commission_cents_corrected, commission_cents, 0)
  ) STORED;

COMMENT ON COLUMN public.kiosk_closings.total_cash_cents IS
  'Cash to collect: the effective count less the effective commission. Computed, never typed.';

-- ---------------------------------------------------------------------------
-- The tablet write, taught the new rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_kiosk_closing(
  p_kiosk_id      uuid,
  p_kiosk_slug    text,
  p_business_id   uuid,
  p_business_date date,
  p_date_label    text,
  p_sales_count   integer,
  p_card_count    integer,
  p_cash_count    integer,
  p_total_cents   integer,
  p_card_cents    integer,
  p_cash_cents    integer,
  p_commission_cents integer,
  p_closed_by_name text,
  p_employee_id   uuid,
  p_products      jsonb,
  p_app_build     text,
  p_device_id     text,
  p_emailed       boolean,
  p_emailed_to    text,
  p_printed_at    text
) RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO public.kiosk_closings (
    kiosk_id, kiosk_slug, business_id, business_date, date_label,
    sales_count, card_count, cash_count,
    total_cents, card_cents, cash_cents, commission_cents,
    closed_by_name, employee_id, products,
    app_build, device_id, emailed, emailed_to, printed_at, closed_at,
    entered_manually
  ) VALUES (
    p_kiosk_id, p_kiosk_slug, p_business_id, p_business_date, p_date_label,
    COALESCE(p_sales_count, 0), COALESCE(p_card_count, 0), COALESCE(p_cash_count, 0),
    COALESCE(p_total_cents, 0), COALESCE(p_card_cents, 0), COALESCE(p_cash_cents, 0),
    p_commission_cents,
    p_closed_by_name, p_employee_id, COALESCE(p_products, '[]'::jsonb),
    p_app_build, p_device_id, COALESCE(p_emailed, false), p_emailed_to, p_printed_at,
    timezone('utc', now()),
    false
  )
  ON CONFLICT (kiosk_id, business_date) DO UPDATE SET
    kiosk_slug     = EXCLUDED.kiosk_slug,
    business_id    = EXCLUDED.business_id,
    date_label     = EXCLUDED.date_label,
    sales_count    = EXCLUDED.sales_count,
    card_count     = EXCLUDED.card_count,
    cash_count     = EXCLUDED.cash_count,
    total_cents    = EXCLUDED.total_cents,
    card_cents     = EXCLUDED.card_cents,
    cash_cents     = EXCLUDED.cash_cents,
    commission_cents = EXCLUDED.commission_cents,
    -- A report is no longer hand-entered once a tablet has spoken for it.
    entered_manually = false,
    -- A correction survives a reprint and survives the first report landing on
    -- a hand-entered night. It dies only when the figure it corrected changed.
    cash_cents_corrected = CASE
      WHEN kiosk_closings.cash_cents IS NOT NULL
       AND EXCLUDED.cash_cents IS DISTINCT FROM kiosk_closings.cash_cents
        THEN NULL ELSE kiosk_closings.cash_cents_corrected END,
    commission_cents_corrected = CASE
      WHEN kiosk_closings.commission_cents IS NOT NULL
       AND EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents
        THEN NULL ELSE kiosk_closings.commission_cents_corrected END,
    -- The sign-off was about the old numbers, so new numbers retire it.
    reviewed_at = CASE
      WHEN (kiosk_closings.cash_cents IS NOT NULL
            AND EXCLUDED.cash_cents IS DISTINCT FROM kiosk_closings.cash_cents)
        OR (kiosk_closings.commission_cents IS NOT NULL
            AND EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents)
        THEN NULL ELSE kiosk_closings.reviewed_at END,
    reviewed_by = CASE
      WHEN (kiosk_closings.cash_cents IS NOT NULL
            AND EXCLUDED.cash_cents IS DISTINCT FROM kiosk_closings.cash_cents)
        OR (kiosk_closings.commission_cents IS NOT NULL
            AND EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents)
        THEN NULL ELSE kiosk_closings.reviewed_by END,
    closed_by_name = COALESCE(EXCLUDED.closed_by_name, kiosk_closings.closed_by_name),
    employee_id    = COALESCE(EXCLUDED.employee_id, kiosk_closings.employee_id),
    products       = EXCLUDED.products,
    app_build      = EXCLUDED.app_build,
    device_id      = EXCLUDED.device_id,
    -- One failed re-send must not erase the fact that the night was emailed.
    emailed        = kiosk_closings.emailed OR EXCLUDED.emailed,
    emailed_to     = COALESCE(EXCLUDED.emailed_to, kiosk_closings.emailed_to),
    printed_at     = EXCLUDED.printed_at,
    closed_at      = EXCLUDED.closed_at
  RETURNING id;
$$;
