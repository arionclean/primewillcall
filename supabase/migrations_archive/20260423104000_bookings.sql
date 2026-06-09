-- Bookings table
-- Requested fields:
-- adult, booking_channel, booking_reference, checked, child, company_id, paxs,
-- date_timestamp, product_id, infant, internal_id, status, supplier, note,
-- check_in_time, customer_id, product_var, peek, price

CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adult integer NOT NULL DEFAULT 0,
  booking_channel text NOT NULL,
  booking_reference text NOT NULL,
  checked boolean NOT NULL DEFAULT false,
  child integer NOT NULL DEFAULT 0,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  paxs integer NOT NULL DEFAULT 0,
  date_timestamp timestamptz NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  infant integer NOT NULL DEFAULT 0,
  internal_id text NOT NULL,
  status text NOT NULL,
  supplier text NOT NULL,
  note text NOT NULL DEFAULT '',
  check_in_time timestamptz,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  product_var text NOT NULL,
  peek boolean NOT NULL DEFAULT false,
  price integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS bookings_company_id_idx ON public.bookings(company_id);
CREATE INDEX IF NOT EXISTS bookings_product_id_idx ON public.bookings(product_id);
CREATE INDEX IF NOT EXISTS bookings_customer_id_idx ON public.bookings(customer_id);
CREATE INDEX IF NOT EXISTS bookings_date_timestamp_idx ON public.bookings(date_timestamp);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON public.bookings(status);

DROP TRIGGER IF EXISTS set_bookings_updated_at ON public.bookings;
CREATE TRIGGER set_bookings_updated_at
BEFORE UPDATE ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bookings_select_own_company" ON public.bookings;
CREATE POLICY "bookings_select_own_company"
ON public.bookings
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = bookings.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "bookings_insert_own_company" ON public.bookings;
CREATE POLICY "bookings_insert_own_company"
ON public.bookings
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = bookings.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "bookings_update_own_company" ON public.bookings;
CREATE POLICY "bookings_update_own_company"
ON public.bookings
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = bookings.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = bookings.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "bookings_delete_own_company" ON public.bookings;
CREATE POLICY "bookings_delete_own_company"
ON public.bookings
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = bookings.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);
