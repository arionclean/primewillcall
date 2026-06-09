-- Customers table
-- Requested fields: first_name, last_name, email, phone, country, company_id

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  country text NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS customers_company_id_idx ON public.customers(company_id);
CREATE INDEX IF NOT EXISTS customers_email_idx ON public.customers(email);

DROP TRIGGER IF EXISTS set_customers_updated_at ON public.customers;
CREATE TRIGGER set_customers_updated_at
BEFORE UPDATE ON public.customers
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_select_own_company" ON public.customers;
CREATE POLICY "customers_select_own_company"
ON public.customers
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customers.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "customers_insert_own_company" ON public.customers;
CREATE POLICY "customers_insert_own_company"
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customers.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "customers_update_own_company" ON public.customers;
CREATE POLICY "customers_update_own_company"
ON public.customers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customers.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customers.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "customers_delete_own_company" ON public.customers;
CREATE POLICY "customers_delete_own_company"
ON public.customers
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = customers.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);
