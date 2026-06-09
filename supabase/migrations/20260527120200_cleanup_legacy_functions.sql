-- Cleanup pass: drop legacy SECURITY DEFINER functions that survived the first drop
-- (their real signatures took arguments — the initial DROP FUNCTION statements
-- with empty arg lists were no-ops). Also harden set_updated_at search_path.

DROP FUNCTION IF EXISTS public.backfill_product_id_map_from_names(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.migrate_legacy_bookings(uuid, text)            CASCADE;
DROP FUNCTION IF EXISTS public.migrate_legacy_customers(uuid, text)           CASCADE;

-- Harden set_updated_at to a fixed search_path (defense-in-depth).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
