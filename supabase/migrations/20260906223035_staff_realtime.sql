-- Let a permission change reach the person it is about.
--
-- The staff row rides in the access token (20260818140000_staff_claims_hook),
-- so the app reads a person's permissions from a token that is reissued about
-- hourly. Saving "can_add_to_peek = false" therefore changed the database at
-- once but not the buttons on that person's screen: a check-in account that
-- signed in at 22:21:54 kept showing Add to Peek and the edit pencil after the
-- owner saved at 22:22:19, off a token minted 25 seconds too early. The
-- database refused the clicks; the screen did not know.
--
-- Publishing `staff` lets the browser subscribe to its own row (the existing
-- staff_select policy already allows cs.staff_id = staff.id) and, on an
-- UPDATE, refresh its session, which reruns the hook and reissues the token
-- with the new permissions (src/components/app/staff-claims-sync.tsx). Owners
-- and managers could stream their team's rows too, exactly as far as they can
-- read them; nobody is sent a row RLS would not return.
--
-- Default replica identity is enough. The one subscriber listens for UPDATE,
-- whose payload is the whole new row at any identity. REPLICA IDENTITY FULL is
-- for filtered DELETE subscribers, and a deleted staffer's next query fails on
-- its own.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'staff'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff;
  END IF;
END
$$;
