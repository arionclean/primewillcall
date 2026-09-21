-- Kiosk closings: one durable row per kiosk per business day.
--
-- The end-of-night close (cash, card, sales count and the commission staff type
-- at the desk) has until now existed in exactly two places: the email Resend
-- sends, and a kiosk_events log line. Neither is a record you can report on. The
-- commission in particular is money that leaves the till, so it needs a row that
-- can be queried, totalled, and corrected when somebody fat-fingers it (kiosk3
-- on 2026-09-19 was closed with a $500 commission against $1,307 of cash; every
-- other night that month was $0 to $200).
--
-- The rules this table encodes:
--   * one close per kiosk per business day. A reprint or a re-send updates that
--     row instead of adding another, so counting closings counts nights.
--   * business_date is the day the tablet says it is reporting, not the clock at
--     the moment it posted. Kiosk3 closes after 8pm ET, kiosk1 sometimes past
--     midnight; both belong to the day they sold on.
--   * commission_cents is what the tablet reported and is never edited in place.
--     A correction lands in commission_cents_corrected with who and why, so the
--     paper form and the database can still be reconciled years later.
--   * total_cash_cents (the money actually handed over) is computed, never typed.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kiosk_closings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id      uuid NOT NULL REFERENCES public.kiosks(id) ON DELETE CASCADE,
  kiosk_slug    text NOT NULL,
  business_id   uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  business_date date NOT NULL,
  date_label    text,

  sales_count   integer NOT NULL DEFAULT 0,
  card_count    integer NOT NULL DEFAULT 0,
  cash_count    integer NOT NULL DEFAULT 0,
  total_cents   integer NOT NULL DEFAULT 0,
  card_cents    integer NOT NULL DEFAULT 0,
  cash_cents    integer NOT NULL DEFAULT 0,

  -- What the tablet reported. NULL means the build predates the commission field.
  commission_cents integer CHECK (commission_cents IS NULL OR commission_cents >= 0),
  -- An owner's correction. NULL means the reported figure still stands.
  commission_cents_corrected integer CHECK (commission_cents_corrected IS NULL OR commission_cents_corrected >= 0),
  corrected_at     timestamptz,
  corrected_by     uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  correction_note  text,

  -- Cash to hand over. Can go negative when a commission exceeds the night's cash,
  -- which is itself worth seeing rather than clamping away.
  total_cash_cents integer GENERATED ALWAYS AS
    (cash_cents - COALESCE(commission_cents_corrected, commission_cents, 0)) STORED,

  closed_by_name text,
  employee_id    uuid REFERENCES public.kiosk_employees(id) ON DELETE SET NULL,
  products       jsonb NOT NULL DEFAULT '[]'::jsonb,

  app_build  text,
  device_id  text,
  emailed    boolean NOT NULL DEFAULT false,
  emailed_to text,
  printed_at text,

  closed_at  timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  UNIQUE (kiosk_id, business_date)
);

COMMENT ON TABLE public.kiosk_closings IS
  'One row per kiosk per business day: the end-of-night close. Written by the kiosk-closing-report edge function, corrected by the owner.';
COMMENT ON COLUMN public.kiosk_closings.commission_cents IS
  'The commission staff typed at close, as reported by the tablet. Never edited in place.';
COMMENT ON COLUMN public.kiosk_closings.commission_cents_corrected IS
  'An owner correction to a mistyped commission. NULL means the reported figure stands.';
COMMENT ON COLUMN public.kiosk_closings.total_cash_cents IS
  'Cash sales less the effective commission. Computed, never typed.';

CREATE INDEX IF NOT EXISTS kiosk_closings_business_date_idx
  ON public.kiosk_closings (business_date DESC);
CREATE INDEX IF NOT EXISTS kiosk_closings_business_id_date_idx
  ON public.kiosk_closings (business_id, business_date DESC);

DROP TRIGGER IF EXISTS set_kiosk_closings_updated_at ON public.kiosk_closings;
CREATE TRIGGER set_kiosk_closings_updated_at
BEFORE UPDATE ON public.kiosk_closings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. The tablet writes through the service role, so no staff INSERT policy
-- exists: a login can read its own business's closings, and only the owner may
-- correct one.
-- ---------------------------------------------------------------------------
ALTER TABLE public.kiosk_closings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kiosk_closings_owner_all ON public.kiosk_closings;
CREATE POLICY kiosk_closings_owner_all ON public.kiosk_closings
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

DROP POLICY IF EXISTS kiosk_closings_manager_select ON public.kiosk_closings;
CREATE POLICY kiosk_closings_manager_select ON public.kiosk_closings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'business_manager'
        AND cs.business_id IS NOT NULL
        AND cs.business_id = kiosk_closings.business_id
    )
  );

-- ---------------------------------------------------------------------------
-- The write. One function so the conflict rule lives in one place.
--
-- A re-sent close overwrites the reported figures. It clears an existing
-- correction ONLY when the tablet's commission actually changed: re-printing the
-- same night must not silently undo the owner's fix, but a genuinely new figure
-- makes the old correction meaningless.
--
-- SECURITY INVOKER: the only caller is the edge function's service-role client,
-- which bypasses RLS already. EXECUTE is granted to service_role alone.
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
    app_build, device_id, emailed, emailed_to, printed_at, closed_at
  ) VALUES (
    p_kiosk_id, p_kiosk_slug, p_business_id, p_business_date, p_date_label,
    COALESCE(p_sales_count, 0), COALESCE(p_card_count, 0), COALESCE(p_cash_count, 0),
    COALESCE(p_total_cents, 0), COALESCE(p_card_cents, 0), COALESCE(p_cash_cents, 0),
    p_commission_cents,
    p_closed_by_name, p_employee_id, COALESCE(p_products, '[]'::jsonb),
    p_app_build, p_device_id, COALESCE(p_emailed, false), p_emailed_to, p_printed_at,
    timezone('utc', now())
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
    -- A correction survives a reprint, but not a genuinely different figure.
    commission_cents_corrected = CASE
      WHEN EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents
        THEN NULL ELSE kiosk_closings.commission_cents_corrected END,
    corrected_at = CASE
      WHEN EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents
        THEN NULL ELSE kiosk_closings.corrected_at END,
    corrected_by = CASE
      WHEN EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents
        THEN NULL ELSE kiosk_closings.corrected_by END,
    correction_note = CASE
      WHEN EXCLUDED.commission_cents IS DISTINCT FROM kiosk_closings.commission_cents
        THEN NULL ELSE kiosk_closings.correction_note END,
    closed_by_name = EXCLUDED.closed_by_name,
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

COMMENT ON FUNCTION public.record_kiosk_closing IS
  'Upsert tonight''s close for one kiosk. Called by the kiosk-closing-report edge function with the service role.';

REVOKE ALL ON FUNCTION public.record_kiosk_closing(
  uuid, text, uuid, date, text, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, jsonb, text, text, boolean, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_kiosk_closing(
  uuid, text, uuid, date, text, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, jsonb, text, text, boolean, text, text
) TO service_role;
