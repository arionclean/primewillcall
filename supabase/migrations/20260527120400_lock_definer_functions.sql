-- Tighten EXECUTE grants on SECURITY DEFINER helpers.
--
-- link_auth_user_to_staff: only the auth.users trigger should call this. Revoke from
-- every API-facing role so /rest/v1/rpc/link_auth_user_to_staff is not reachable.
-- The trigger still works because triggers run as the function's definer, not the
-- caller — execute privilege is bypassed.
REVOKE EXECUTE ON FUNCTION public.link_auth_user_to_staff() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_auth_user_to_staff() FROM anon;
REVOKE EXECUTE ON FUNCTION public.link_auth_user_to_staff() FROM authenticated;

-- current_staff: intentionally callable by `authenticated` — RLS policies invoke it.
-- It only returns the caller's own staff row, so direct RPC access is not a leak.
-- The advisor lint here is acknowledged-and-accepted, not a bug.
COMMENT ON FUNCTION public.current_staff() IS
  'Returns the caller''s active staff row. SECURITY DEFINER so it can read public.staff inside its own RLS policies without recursion. Safe to expose to authenticated: it only ever reveals the caller''s own row.';
