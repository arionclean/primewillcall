-- PrimeWillCall auth profile model
-- Roles supported: merchant, kiosk

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'app_role'
  ) THEN
    CREATE TYPE public.app_role AS ENUM ('merchant', 'kiosk');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.app_users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL DEFAULT 'kiosk',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_app_users_updated_at ON public.app_users;
CREATE TRIGGER set_app_users_updated_at
BEFORE UPDATE ON public.app_users
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_users_select_own" ON public.app_users;
CREATE POLICY "app_users_select_own"
ON public.app_users
FOR SELECT
TO authenticated
USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "app_users_update_own_no_role_change" ON public.app_users;
CREATE POLICY "app_users_update_own_no_role_change"
ON public.app_users
FOR UPDATE
TO authenticated
USING ((select auth.uid()) = id)
WITH CHECK (
  (select auth.uid()) = id
  AND role = (SELECT role FROM public.app_users WHERE id = (select auth.uid()))
);

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.app_role;
BEGIN
  v_role := CASE COALESCE(NEW.raw_user_meta_data ->> 'role', '')
    WHEN 'merchant' THEN 'merchant'::public.app_role
    WHEN 'kiosk' THEN 'kiosk'::public.app_role
    ELSE 'kiosk'::public.app_role
  END;

  INSERT INTO public.app_users (id, role)
  VALUES (NEW.id, v_role)
  ON CONFLICT (id)
  DO UPDATE SET
    role = EXCLUDED.role,
    updated_at = timezone('utc', now());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill users that may exist before the trigger.
INSERT INTO public.app_users (id, role)
SELECT
  u.id,
  CASE COALESCE(u.raw_user_meta_data ->> 'role', '')
    WHEN 'merchant' THEN 'merchant'::public.app_role
    WHEN 'kiosk' THEN 'kiosk'::public.app_role
    ELSE 'kiosk'::public.app_role
  END AS role
FROM auth.users u
ON CONFLICT (id) DO NOTHING;
