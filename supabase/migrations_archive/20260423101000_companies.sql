-- Companies profile table (owned by app_users)
-- Requested fields: charges_enabled, email, name, profile_foto, stripe_account_id, user(owner)

CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  profile_foto text,
  stripe_account_id text,
  charges_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT companies_email_unique UNIQUE (email),
  CONSTRAINT companies_stripe_account_id_unique UNIQUE (stripe_account_id)
);

CREATE INDEX IF NOT EXISTS companies_user_id_idx ON public.companies(user_id);

DROP TRIGGER IF EXISTS set_companies_updated_at ON public.companies;
CREATE TRIGGER set_companies_updated_at
BEFORE UPDATE ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "companies_select_own" ON public.companies;
CREATE POLICY "companies_select_own"
ON public.companies
FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "companies_insert_own" ON public.companies;
CREATE POLICY "companies_insert_own"
ON public.companies
FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "companies_update_own" ON public.companies;
CREATE POLICY "companies_update_own"
ON public.companies
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "companies_delete_own" ON public.companies;
CREATE POLICY "companies_delete_own"
ON public.companies
FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);
