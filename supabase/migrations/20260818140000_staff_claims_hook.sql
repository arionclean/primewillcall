-- Put the staff row in the access token.
--
-- Every navigation was running one query to answer "who is this?": the layout
-- looked up the staff row by user_id before it could render anything. That is
-- roughly 140 to 200ms on every screen, and it is the same answer every time.
-- This hook writes the row into the JWT when the token is issued, so the app
-- reads it locally and the query disappears.
--
-- Security is unchanged. RLS still calls current_staff(), which reads the live
-- staff table on every statement, so a revoked permission takes effect on the
-- next query no matter what the token says. The claims only drive the UI.
--
-- The tradeoff is staleness: a token is reissued about hourly, so a role or
-- permission edit can take that long to show up in someone's sidebar. Their
-- database access changes immediately regardless. See docs/DATABASE.md.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  s      public.staff%ROWTYPE;
  claims jsonb;
BEGIN
  SELECT * INTO s
  FROM public.staff
  WHERE user_id = (event->>'user_id')::uuid
  LIMIT 1;

  claims := event->'claims';

  IF s.id IS NULL THEN
    -- Signed in but not on the team. The app already handles this; say so
    -- explicitly rather than leaving the claim absent, which the app reads as
    -- "this token predates the hook, go and ask the database".
    claims := jsonb_set(claims, '{app_staff}', 'null'::jsonb);
  ELSE
    claims := jsonb_set(claims, '{app_staff}', jsonb_build_object(
      'id',                  s.id,
      'full_name',           s.full_name,
      'role',                s.role,
      'business_id',         s.business_id,
      'is_active',           s.is_active,
      'kiosk_slug',          s.kiosk_slug,
      'can_create_bookings', s.can_create_bookings,
      'can_edit_bookings',   s.can_edit_bookings,
      'can_check_in',        s.can_check_in,
      'can_delete_bookings', s.can_delete_bookings,
      'can_add_to_peek',     s.can_add_to_peek
    ));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

-- Only the auth server may run it, and it needs to read staff to do so.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;
GRANT SELECT ON TABLE public.staff TO supabase_auth_admin;

DROP POLICY IF EXISTS staff_select_auth_admin ON public.staff;
CREATE POLICY staff_select_auth_admin ON public.staff
  FOR SELECT TO supabase_auth_admin
  USING (true);
