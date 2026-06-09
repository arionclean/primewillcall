-- Legacy CSV import pipeline
-- Purpose:
-- 1) Stage raw legacy bookings data without strict typing
-- 2) Map legacy IDs to new UUIDs (products/customers)
-- 3) Upsert into public.bookings safely and idempotently

-- ---------------------------------------------------------------------------
-- Bookings lineage columns for idempotent imports
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings
ADD COLUMN IF NOT EXISTS source_system text;

ALTER TABLE public.bookings
ADD COLUMN IF NOT EXISTS source_booking_id text;

DROP INDEX IF EXISTS bookings_company_source_booking_unique;
CREATE UNIQUE INDEX bookings_company_source_booking_unique
ON public.bookings(company_id, source_system, source_booking_id);

-- ---------------------------------------------------------------------------
-- Staging table for legacy CSV rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stg_bookings_raw (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_system text NOT NULL DEFAULT 'legacy',
  import_batch text NOT NULL DEFAULT 'default',
  old_booking_id text,
  old_product_id text,
  old_product_name text,
  old_customer_id text,
  customer_email text,
  customer_first_name text,
  customer_last_name text,
  customer_phone text,
  customer_country text,
  adult text,
  booking_channel text,
  booking_reference text,
  checked text,
  child text,
  infant text,
  paxs text,
  date_timestamp text,
  check_in_time text,
  internal_id text,
  status text,
  supplier text,
  note text,
  product_var text,
  peek text,
  price text,
  raw_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS stg_bookings_raw_company_source_idx
ON public.stg_bookings_raw(company_id, source_system);

CREATE INDEX IF NOT EXISTS stg_bookings_raw_old_product_id_idx
ON public.stg_bookings_raw(old_product_id);

CREATE INDEX IF NOT EXISTS stg_bookings_raw_old_customer_id_idx
ON public.stg_bookings_raw(old_customer_id);

ALTER TABLE public.stg_bookings_raw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stg_bookings_raw_select_own_company" ON public.stg_bookings_raw;
CREATE POLICY "stg_bookings_raw_select_own_company"
ON public.stg_bookings_raw
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = stg_bookings_raw.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "stg_bookings_raw_insert_own_company" ON public.stg_bookings_raw;
CREATE POLICY "stg_bookings_raw_insert_own_company"
ON public.stg_bookings_raw
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = stg_bookings_raw.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "stg_bookings_raw_update_own_company" ON public.stg_bookings_raw;
CREATE POLICY "stg_bookings_raw_update_own_company"
ON public.stg_bookings_raw
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = stg_bookings_raw.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = stg_bookings_raw.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "stg_bookings_raw_delete_own_company" ON public.stg_bookings_raw;
CREATE POLICY "stg_bookings_raw_delete_own_company"
ON public.stg_bookings_raw
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = stg_bookings_raw.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- Product mapping table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_id_map (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  old_product_id text NOT NULL,
  old_product_name text,
  new_product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  match_method text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (company_id, source_system, old_product_id)
);

CREATE INDEX IF NOT EXISTS product_id_map_new_product_idx
ON public.product_id_map(new_product_id);

DROP TRIGGER IF EXISTS set_product_id_map_updated_at ON public.product_id_map;
CREATE TRIGGER set_product_id_map_updated_at
BEFORE UPDATE ON public.product_id_map
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.product_id_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_id_map_select_own_company" ON public.product_id_map;
CREATE POLICY "product_id_map_select_own_company"
ON public.product_id_map
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = product_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "product_id_map_insert_own_company" ON public.product_id_map;
CREATE POLICY "product_id_map_insert_own_company"
ON public.product_id_map
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = product_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "product_id_map_update_own_company" ON public.product_id_map;
CREATE POLICY "product_id_map_update_own_company"
ON public.product_id_map
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = product_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = product_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "product_id_map_delete_own_company" ON public.product_id_map;
CREATE POLICY "product_id_map_delete_own_company"
ON public.product_id_map
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = product_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- Customer mapping table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_id_map (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  old_customer_id text NOT NULL,
  new_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  match_method text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (company_id, source_system, old_customer_id)
);

CREATE INDEX IF NOT EXISTS customer_id_map_new_customer_idx
ON public.customer_id_map(new_customer_id);

DROP TRIGGER IF EXISTS set_customer_id_map_updated_at ON public.customer_id_map;
CREATE TRIGGER set_customer_id_map_updated_at
BEFORE UPDATE ON public.customer_id_map
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.customer_id_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_id_map_select_own_company" ON public.customer_id_map;
CREATE POLICY "customer_id_map_select_own_company"
ON public.customer_id_map
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customer_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "customer_id_map_insert_own_company" ON public.customer_id_map;
CREATE POLICY "customer_id_map_insert_own_company"
ON public.customer_id_map
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customer_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "customer_id_map_update_own_company" ON public.customer_id_map;
CREATE POLICY "customer_id_map_update_own_company"
ON public.customer_id_map
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customer_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customer_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "customer_id_map_delete_own_company" ON public.customer_id_map;
CREATE POLICY "customer_id_map_delete_own_company"
ON public.customer_id_map
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customer_id_map.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_legacy_text(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '', 'g');
$$;

CREATE OR REPLACE FUNCTION public.safe_int(value text, fallback integer DEFAULT 0)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cleaned text;
BEGIN
  cleaned := nullif(regexp_replace(coalesce(value, ''), '[^0-9-]+', '', 'g'), '');
  IF cleaned IS NULL THEN
    RETURN fallback;
  END IF;
  RETURN cleaned::integer;
EXCEPTION WHEN OTHERS THEN
  RETURN fallback;
END;
$$;

CREATE OR REPLACE FUNCTION public.safe_bool(value text, fallback boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL OR btrim(value) = '' THEN fallback
    WHEN lower(btrim(value)) IN ('1', 't', 'true', 'yes', 'y') THEN true
    WHEN lower(btrim(value)) IN ('0', 'f', 'false', 'no', 'n') THEN false
    ELSE fallback
  END;
$$;

CREATE OR REPLACE FUNCTION public.safe_timestamptz(value text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  trimmed text;
  numeric_epoch numeric;
BEGIN
  trimmed := btrim(coalesce(value, ''));

  IF trimmed = '' THEN
    RETURN NULL;
  END IF;

  IF trimmed ~ '^[0-9]+$' THEN
    numeric_epoch := trimmed::numeric;

    IF numeric_epoch <= 0 THEN
      RETURN NULL;
    END IF;

    -- Treat 13+ digits as milliseconds, 10 digits as seconds.
    IF length(trimmed) >= 13 THEN
      RETURN to_timestamp(numeric_epoch / 1000.0);
    END IF;

    RETURN to_timestamp(numeric_epoch);
  END IF;

  RETURN trimmed::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.backfill_product_id_map_from_names(
  p_company_id uuid,
  p_source_system text DEFAULT 'legacy'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO public.product_id_map (
    company_id,
    source_system,
    old_product_id,
    old_product_name,
    new_product_id,
    match_method
  )
  SELECT DISTINCT
    s.company_id,
    s.source_system,
    s.old_product_id,
    s.old_product_name,
    p.id,
    CASE
      WHEN public.normalize_legacy_text(s.old_product_name) = public.normalize_legacy_text(p.product_name)
        THEN 'product_name_exact_normalized'
      ELSE 'name_variation_exact_normalized'
    END AS match_method
  FROM public.stg_bookings_raw s
  JOIN public.products p
    ON p.company_id = s.company_id
  WHERE s.company_id = p_company_id
    AND s.source_system = p_source_system
    AND nullif(btrim(s.old_product_id), '') IS NOT NULL
    AND nullif(btrim(s.old_product_name), '') IS NOT NULL
    AND (
      public.normalize_legacy_text(s.old_product_name) = public.normalize_legacy_text(p.product_name)
      OR EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.name_variations, '{}'::text[])) AS nv(name_var)
        WHERE public.normalize_legacy_text(s.old_product_name) = public.normalize_legacy_text(nv.name_var)
      )
    )
  ON CONFLICT (company_id, source_system, old_product_id) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.migrate_legacy_customers(
  p_company_id uuid,
  p_source_system text DEFAULT 'legacy'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload jsonb;
BEGIN
  WITH source_rows AS (
    SELECT
      s.company_id,
      s.source_system,
      nullif(btrim(s.old_customer_id), '') AS old_customer_id,
      lower(nullif(btrim(s.customer_email), '')) AS customer_email,
      nullif(btrim(s.customer_first_name), '') AS customer_first_name,
      nullif(btrim(s.customer_last_name), '') AS customer_last_name,
      nullif(btrim(s.customer_phone), '') AS customer_phone,
      nullif(btrim(s.customer_country), '') AS customer_country
    FROM public.stg_bookings_raw s
    WHERE s.company_id = p_company_id
      AND s.source_system = p_source_system
  ),
  dedup AS (
    SELECT DISTINCT ON (
      coalesce(
        old_customer_id,
        customer_email,
        customer_phone,
        md5(coalesce(customer_first_name, '') || '|' || coalesce(customer_last_name, ''))
      )
    )
      company_id,
      source_system,
      old_customer_id,
      customer_email,
      customer_first_name,
      customer_last_name,
      customer_phone,
      customer_country
    FROM source_rows
    WHERE old_customer_id IS NOT NULL OR customer_email IS NOT NULL
    ORDER BY
      coalesce(
        old_customer_id,
        customer_email,
        customer_phone,
        md5(coalesce(customer_first_name, '') || '|' || coalesce(customer_last_name, ''))
      ),
      old_customer_id NULLS LAST
  ),
  normalized AS (
    SELECT
      company_id,
      source_system,
      old_customer_id,
      coalesce(customer_first_name, 'Unknown') AS first_name,
      coalesce(customer_last_name, 'Unknown') AS last_name,
      coalesce(
        customer_email,
        'legacy+' || substr(md5(coalesce(old_customer_id, coalesce(customer_phone, '') || '|' || coalesce(customer_first_name, '') || '|' || coalesce(customer_last_name, ''))), 1, 16) || '@legacy.local'
      ) AS email,
      coalesce(customer_phone, 'N/A') AS phone,
      coalesce(customer_country, 'Unknown') AS country
    FROM dedup
  ),
  inserted AS (
    INSERT INTO public.customers (first_name, last_name, email, phone, country, company_id)
    SELECT
      n.first_name,
      n.last_name,
      n.email,
      n.phone,
      n.country,
      n.company_id
    FROM normalized n
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.company_id = n.company_id
        AND lower(c.email) = lower(n.email)
    )
    RETURNING id, company_id, email
  ),
  mapped AS (
    INSERT INTO public.customer_id_map (
      company_id,
      source_system,
      old_customer_id,
      new_customer_id,
      match_method
    )
    SELECT
      n.company_id,
      n.source_system,
      n.old_customer_id,
      c.id,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM inserted i
          WHERE i.company_id = n.company_id
            AND lower(i.email) = lower(n.email)
        ) THEN 'inserted_from_staging'
        ELSE 'matched_by_email'
      END AS match_method
    FROM normalized n
    JOIN public.customers c
      ON c.company_id = n.company_id
     AND lower(c.email) = lower(n.email)
    WHERE n.old_customer_id IS NOT NULL
    ON CONFLICT (company_id, source_system, old_customer_id)
    DO UPDATE SET
      new_customer_id = EXCLUDED.new_customer_id,
      match_method = EXCLUDED.match_method,
      updated_at = timezone('utc', now())
    RETURNING 1
  )
  SELECT jsonb_build_object(
    'customers_inserted', (SELECT count(*) FROM inserted),
    'customer_mappings_upserted', (SELECT count(*) FROM mapped)
  )
  INTO payload;

  RETURN payload;
END;
$$;

CREATE OR REPLACE FUNCTION public.migrate_legacy_bookings(
  p_company_id uuid,
  p_source_system text DEFAULT 'legacy'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload jsonb;
BEGIN
  WITH prepared AS (
    SELECT
      s.id AS staging_id,
      s.company_id,
      s.source_system,
      coalesce(
        nullif(btrim(s.old_booking_id), ''),
        md5(coalesce(s.booking_reference, '') || '|' || coalesce(s.date_timestamp, '') || '|' || coalesce(s.old_product_id, ''))
      ) AS source_booking_id,
      pm.new_product_id,
      cm.new_customer_id,
      public.safe_timestamptz(s.date_timestamp) AS parsed_date_timestamp,
      public.safe_timestamptz(s.check_in_time) AS parsed_check_in_time,
      public.safe_int(s.adult, 0) AS adult,
      public.safe_int(s.child, 0) AS child,
      public.safe_int(s.infant, 0) AS infant,
      public.safe_int(s.paxs, NULL) AS paxs_raw,
      public.safe_bool(s.checked, false) AS checked,
      public.safe_bool(s.peek, false) AS peek,
      public.safe_int(s.price, 0) AS price,
      coalesce(nullif(btrim(s.booking_channel), ''), 'legacy') AS booking_channel,
      coalesce(nullif(btrim(s.booking_reference), ''), coalesce(nullif(btrim(s.old_booking_id), ''), 'legacy')) AS booking_reference,
      coalesce(nullif(btrim(s.internal_id), ''), coalesce(nullif(btrim(s.old_booking_id), ''), 'legacy')) AS internal_id,
      coalesce(nullif(btrim(s.status), ''), 'unknown') AS status,
      coalesce(nullif(btrim(s.supplier), ''), 'legacy') AS supplier,
      coalesce(s.note, '') AS note,
      coalesce(nullif(btrim(s.product_var), ''), coalesce(nullif(btrim(s.old_product_name), ''), 'legacy')) AS product_var
    FROM public.stg_bookings_raw s
    LEFT JOIN public.product_id_map pm
      ON pm.company_id = s.company_id
     AND pm.source_system = s.source_system
     AND pm.old_product_id = s.old_product_id
    LEFT JOIN public.customer_id_map cm
      ON cm.company_id = s.company_id
     AND cm.source_system = s.source_system
     AND cm.old_customer_id = s.old_customer_id
    WHERE s.company_id = p_company_id
      AND s.source_system = p_source_system
  ),
  valid AS (
    SELECT
      p.*,
      coalesce(p.paxs_raw, greatest(p.adult, 0) + greatest(p.child, 0) + greatest(p.infant, 0)) AS paxs
    FROM prepared p
    WHERE p.parsed_date_timestamp IS NOT NULL
      AND p.new_product_id IS NOT NULL
  ),
  upserted AS (
    INSERT INTO public.bookings (
      adult,
      booking_channel,
      booking_reference,
      checked,
      child,
      company_id,
      paxs,
      date_timestamp,
      product_id,
      infant,
      internal_id,
      status,
      supplier,
      note,
      check_in_time,
      customer_id,
      product_var,
      peek,
      price,
      source_system,
      source_booking_id
    )
    SELECT
      greatest(v.adult, 0),
      v.booking_channel,
      v.booking_reference,
      v.checked,
      greatest(v.child, 0),
      v.company_id,
      greatest(v.paxs, 0),
      v.parsed_date_timestamp,
      v.new_product_id,
      greatest(v.infant, 0),
      v.internal_id,
      v.status,
      v.supplier,
      v.note,
      v.parsed_check_in_time,
      v.new_customer_id,
      v.product_var,
      v.peek,
      v.price,
      v.source_system,
      v.source_booking_id
    FROM valid v
    ON CONFLICT (company_id, source_system, source_booking_id)
    DO UPDATE SET
      adult = EXCLUDED.adult,
      booking_channel = EXCLUDED.booking_channel,
      booking_reference = EXCLUDED.booking_reference,
      checked = EXCLUDED.checked,
      child = EXCLUDED.child,
      paxs = EXCLUDED.paxs,
      date_timestamp = EXCLUDED.date_timestamp,
      product_id = EXCLUDED.product_id,
      infant = EXCLUDED.infant,
      internal_id = EXCLUDED.internal_id,
      status = EXCLUDED.status,
      supplier = EXCLUDED.supplier,
      note = EXCLUDED.note,
      check_in_time = EXCLUDED.check_in_time,
      customer_id = EXCLUDED.customer_id,
      product_var = EXCLUDED.product_var,
      peek = EXCLUDED.peek,
      price = EXCLUDED.price,
      updated_at = timezone('utc', now())
    RETURNING 1
  )
  SELECT jsonb_build_object(
    'staged_rows', (SELECT count(*) FROM prepared),
    'rows_with_unmapped_product', (SELECT count(*) FROM prepared WHERE new_product_id IS NULL),
    'rows_with_invalid_date', (SELECT count(*) FROM prepared WHERE parsed_date_timestamp IS NULL),
    'rows_upserted', (SELECT count(*) FROM upserted)
  )
  INTO payload;

  RETURN payload;
END;
$$;

-- ---------------------------------------------------------------------------
-- Diagnostics views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_legacy_unmapped_products AS
SELECT
  s.company_id,
  s.source_system,
  s.old_product_id,
  s.old_product_name,
  count(*) AS booking_rows
FROM public.stg_bookings_raw s
LEFT JOIN public.product_id_map m
  ON m.company_id = s.company_id
 AND m.source_system = s.source_system
 AND m.old_product_id = s.old_product_id
WHERE m.old_product_id IS NULL
  AND nullif(btrim(s.old_product_id), '') IS NOT NULL
GROUP BY s.company_id, s.source_system, s.old_product_id, s.old_product_name
ORDER BY booking_rows DESC;

CREATE OR REPLACE VIEW public.v_legacy_staging_summary AS
SELECT
  s.company_id,
  s.source_system,
  s.import_batch,
  count(*) AS staged_rows,
  count(*) FILTER (WHERE nullif(btrim(s.old_booking_id), '') IS NULL) AS rows_without_old_booking_id,
  count(*) FILTER (WHERE nullif(btrim(s.old_product_id), '') IS NULL) AS rows_without_old_product_id,
  count(*) FILTER (WHERE public.safe_timestamptz(s.date_timestamp) IS NULL) AS rows_with_invalid_date
FROM public.stg_bookings_raw s
GROUP BY s.company_id, s.source_system, s.import_batch;
