-- Product creation fields
-- Additive only. Keeps products.id as UUID because bookings reference it.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS legacy_id integer,
  ADD COLUMN IF NOT EXISTS internal_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS company text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS meeting_point_address text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS meeting_point_description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS meeting_point_latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS meeting_point_longitude numeric(10,7);

CREATE UNIQUE INDEX IF NOT EXISTS products_company_legacy_id_uidx
ON public.products(company_id, legacy_id)
WHERE legacy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS products_company_internal_id_uidx
ON public.products(company_id, internal_id)
WHERE internal_id <> '';
