-- Team accounts, permissions, and product access.
-- Additive only. Owner access remains controlled through companies.user_id.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'team_role'
  ) THEN
    CREATE TYPE public.team_role AS ENUM ('admin', 'kiosk');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  auth_user_id uuid UNIQUE REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  role public.team_role NOT NULL DEFAULT 'kiosk',
  is_active boolean NOT NULL DEFAULT true,
  can_edit_booking boolean NOT NULL DEFAULT false,
  can_delete_booking boolean NOT NULL DEFAULT false,
  can_delete_transaction boolean NOT NULL DEFAULT false,
  can_refund boolean NOT NULL DEFAULT false,
  can_create_booking boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT team_members_company_email_unique UNIQUE (company_id, email)
);

CREATE INDEX IF NOT EXISTS team_members_company_id_idx
ON public.team_members(company_id);

CREATE INDEX IF NOT EXISTS team_members_auth_user_id_idx
ON public.team_members(auth_user_id);

DROP TRIGGER IF EXISTS set_team_members_updated_at ON public.team_members;
CREATE TRIGGER set_team_members_updated_at
BEFORE UPDATE ON public.team_members
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.team_member_products (
  team_member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (team_member_id, product_id)
);

CREATE INDEX IF NOT EXISTS team_member_products_product_id_idx
ON public.team_member_products(product_id);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_members_owner_select" ON public.team_members;
CREATE POLICY "team_members_owner_select"
ON public.team_members
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = team_members.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "team_members_owner_insert" ON public.team_members;
CREATE POLICY "team_members_owner_insert"
ON public.team_members
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = team_members.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "team_members_owner_update" ON public.team_members;
CREATE POLICY "team_members_owner_update"
ON public.team_members
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = team_members.company_id
      AND c.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = team_members.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "team_members_owner_delete" ON public.team_members;
CREATE POLICY "team_members_owner_delete"
ON public.team_members
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = team_members.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "team_member_products_owner_select" ON public.team_member_products;
CREATE POLICY "team_member_products_owner_select"
ON public.team_member_products
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.team_members tm
    JOIN public.companies c ON c.id = tm.company_id
    WHERE tm.id = team_member_products.team_member_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "team_member_products_owner_insert" ON public.team_member_products;
CREATE POLICY "team_member_products_owner_insert"
ON public.team_member_products
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.team_members tm
    JOIN public.companies c ON c.id = tm.company_id
    JOIN public.products p ON p.id = team_member_products.product_id
    WHERE tm.id = team_member_products.team_member_id
      AND p.company_id = tm.company_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "team_member_products_owner_delete" ON public.team_member_products;
CREATE POLICY "team_member_products_owner_delete"
ON public.team_member_products
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.team_members tm
    JOIN public.companies c ON c.id = tm.company_id
    WHERE tm.id = team_member_products.team_member_id
      AND c.user_id = (SELECT auth.uid())
  )
);
