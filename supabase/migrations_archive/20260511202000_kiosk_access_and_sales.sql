-- Kiosk access and sales ledger.
-- Additive only. Owner policies stay in place; this adds team-member read/create paths.

CREATE OR REPLACE FUNCTION public.active_team_member_for_company(p_company_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.id
  FROM public.team_members tm
  WHERE tm.company_id = p_company_id
    AND tm.auth_user_id = auth.uid()
    AND tm.is_active
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.team_member_can_access_product(p_product_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members tm
    JOIN public.team_member_products tmp ON tmp.team_member_id = tm.id
    JOIN public.products p ON p.id = tmp.product_id
    WHERE tm.auth_user_id = auth.uid()
      AND tm.is_active
      AND tmp.product_id = p_product_id
      AND p.company_id = tm.company_id
  )
$$;

CREATE OR REPLACE FUNCTION public.team_member_has_permission(p_company_id uuid, p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE tm.company_id = p_company_id
      AND tm.auth_user_id = auth.uid()
      AND tm.is_active
      AND (
        tm.role = 'admin'
        OR CASE p_permission
          WHEN 'can_edit_booking' THEN tm.can_edit_booking
          WHEN 'can_delete_booking' THEN tm.can_delete_booking
          WHEN 'can_delete_transaction' THEN tm.can_delete_transaction
          WHEN 'can_refund' THEN tm.can_refund
          WHEN 'can_create_booking' THEN tm.can_create_booking
          ELSE false
        END
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.team_member_can_create_booking(p_company_id uuid, p_product_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.team_member_has_permission(p_company_id, 'can_create_booking')
    AND public.team_member_can_access_product(p_product_id)
$$;

REVOKE ALL ON FUNCTION public.active_team_member_for_company(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.team_member_can_access_product(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.team_member_has_permission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.team_member_can_create_booking(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.active_team_member_for_company(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.team_member_can_access_product(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.team_member_has_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.team_member_can_create_booking(uuid, uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.kiosk_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  payment_type text NOT NULL CHECK (payment_type IN ('cash', 'card_link', 'qr', 'tap')),
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'pending', 'failed', 'refunded')),
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  stripe_charge_id text,
  connected_account_id text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS kiosk_sales_company_created_at_idx
ON public.kiosk_sales(company_id, created_at);

CREATE INDEX IF NOT EXISTS kiosk_sales_product_id_idx
ON public.kiosk_sales(product_id);

CREATE INDEX IF NOT EXISTS kiosk_sales_booking_id_idx
ON public.kiosk_sales(booking_id);

CREATE INDEX IF NOT EXISTS kiosk_sales_team_member_id_idx
ON public.kiosk_sales(team_member_id);

DROP TRIGGER IF EXISTS set_kiosk_sales_updated_at ON public.kiosk_sales;
CREATE TRIGGER set_kiosk_sales_updated_at
BEFORE UPDATE ON public.kiosk_sales
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.kiosk_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "companies_team_select" ON public.companies;
CREATE POLICY "companies_team_select"
ON public.companies
FOR SELECT
TO authenticated
USING (public.active_team_member_for_company(companies.id) IS NOT NULL);

DROP POLICY IF EXISTS "team_members_self_select" ON public.team_members;
CREATE POLICY "team_members_self_select"
ON public.team_members
FOR SELECT
TO authenticated
USING (auth_user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "team_member_products_self_select" ON public.team_member_products;
CREATE POLICY "team_member_products_self_select"
ON public.team_member_products
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE tm.id = team_member_products.team_member_id
      AND tm.auth_user_id = (SELECT auth.uid())
      AND tm.is_active
  )
);

DROP POLICY IF EXISTS "products_team_select_allowed" ON public.products;
CREATE POLICY "products_team_select_allowed"
ON public.products
FOR SELECT
TO authenticated
USING (public.team_member_can_access_product(products.id));

DROP POLICY IF EXISTS "customers_team_select_company" ON public.customers;
CREATE POLICY "customers_team_select_company"
ON public.customers
FOR SELECT
TO authenticated
USING (public.active_team_member_for_company(customers.company_id) IS NOT NULL);

DROP POLICY IF EXISTS "customers_team_insert_booking" ON public.customers;
CREATE POLICY "customers_team_insert_booking"
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (public.team_member_has_permission(customers.company_id, 'can_create_booking'));

DROP POLICY IF EXISTS "bookings_team_select_allowed_products" ON public.bookings;
CREATE POLICY "bookings_team_select_allowed_products"
ON public.bookings
FOR SELECT
TO authenticated
USING (public.team_member_can_access_product(bookings.product_id));

DROP POLICY IF EXISTS "bookings_team_insert_allowed_products" ON public.bookings;
CREATE POLICY "bookings_team_insert_allowed_products"
ON public.bookings
FOR INSERT
TO authenticated
WITH CHECK (public.team_member_can_create_booking(bookings.company_id, bookings.product_id));

DROP POLICY IF EXISTS "bookings_team_update_allowed_products" ON public.bookings;
CREATE POLICY "bookings_team_update_allowed_products"
ON public.bookings
FOR UPDATE
TO authenticated
USING (
  public.team_member_has_permission(bookings.company_id, 'can_edit_booking')
  AND public.team_member_can_access_product(bookings.product_id)
)
WITH CHECK (
  public.team_member_has_permission(bookings.company_id, 'can_edit_booking')
  AND public.team_member_can_access_product(bookings.product_id)
);

DROP POLICY IF EXISTS "bookings_team_delete_allowed_products" ON public.bookings;
CREATE POLICY "bookings_team_delete_allowed_products"
ON public.bookings
FOR DELETE
TO authenticated
USING (
  public.team_member_has_permission(bookings.company_id, 'can_delete_booking')
  AND public.team_member_can_access_product(bookings.product_id)
);

DROP POLICY IF EXISTS "kiosk_sales_owner_select" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_owner_select"
ON public.kiosk_sales
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = kiosk_sales.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "kiosk_sales_owner_insert" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_owner_insert"
ON public.kiosk_sales
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = kiosk_sales.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "kiosk_sales_owner_update" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_owner_update"
ON public.kiosk_sales
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = kiosk_sales.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = kiosk_sales.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "kiosk_sales_owner_delete" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_owner_delete"
ON public.kiosk_sales
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = kiosk_sales.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "kiosk_sales_team_select_allowed_products" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_team_select_allowed_products"
ON public.kiosk_sales
FOR SELECT
TO authenticated
USING (public.team_member_can_access_product(kiosk_sales.product_id));

DROP POLICY IF EXISTS "kiosk_sales_team_insert_allowed_products" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_team_insert_allowed_products"
ON public.kiosk_sales
FOR INSERT
TO authenticated
WITH CHECK (
  public.team_member_can_create_booking(kiosk_sales.company_id, kiosk_sales.product_id)
  AND kiosk_sales.team_member_id = public.active_team_member_for_company(kiosk_sales.company_id)
);

DROP POLICY IF EXISTS "kiosk_sales_team_update_transactions" ON public.kiosk_sales;
CREATE POLICY "kiosk_sales_team_update_transactions"
ON public.kiosk_sales
FOR UPDATE
TO authenticated
USING (
  public.team_member_has_permission(kiosk_sales.company_id, 'can_delete_transaction')
  AND public.team_member_can_access_product(kiosk_sales.product_id)
)
WITH CHECK (
  public.team_member_has_permission(kiosk_sales.company_id, 'can_delete_transaction')
  AND public.team_member_can_access_product(kiosk_sales.product_id)
);
