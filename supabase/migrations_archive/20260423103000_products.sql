-- Products table
-- Requested fields: product_name, name_variations[text], company_id, price(json), timeslots(json), short_name, color, pickup_location

CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL,
  name_variations text[] NOT NULL DEFAULT '{}',
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  price jsonb NOT NULL DEFAULT '{}'::jsonb,
  groupon_fee numeric(12,2) NOT NULL DEFAULT 0,
  timeslots jsonb NOT NULL DEFAULT '[]'::jsonb,
  short_name text NOT NULL,
  color text NOT NULL,
  pickup_location text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS products_company_id_idx ON public.products(company_id);
CREATE INDEX IF NOT EXISTS products_name_variations_idx ON public.products USING GIN (name_variations);

DROP TRIGGER IF EXISTS set_products_updated_at ON public.products;
CREATE TRIGGER set_products_updated_at
BEFORE UPDATE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "products_select_own_company" ON public.products;
CREATE POLICY "products_select_own_company"
ON public.products
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = products.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "products_insert_own_company" ON public.products;
CREATE POLICY "products_insert_own_company"
ON public.products
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = products.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "products_update_own_company" ON public.products;
CREATE POLICY "products_update_own_company"
ON public.products
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = products.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = products.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "products_delete_own_company" ON public.products;
CREATE POLICY "products_delete_own_company"
ON public.products
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = products.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);
