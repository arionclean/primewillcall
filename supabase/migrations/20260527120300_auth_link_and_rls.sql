-- Auth wiring + RLS policies.
-- Strategy:
--   1. SECURITY DEFINER helper `current_staff()` returns the calling user's staff row
--      (bypasses RLS on staff itself; that's the only safe way to read staff inside its own policies).
--   2. Trigger on auth.users INSERT links a new auth user to their pre-existing staff row by email.
--   3. Policies per table — owner/business_manager/check_in scoping for SELECT;
--      owner full write everywhere; manager scoped write inside their business;
--      check_in narrow writes (booking check-in, walk-in customer create).
--   4. supabase_realtime publication scoped to bookings + kiosks only to keep usage cheap.

-- ──────────────────────────────────────────────────────────────────────────────
-- Helper: current_staff()
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_staff()
RETURNS TABLE(staff_id uuid, role public.staff_role, business_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.role, s.business_id
  FROM public.staff s
  WHERE s.user_id = auth.uid() AND s.is_active = true
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.current_staff() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_staff() FROM anon;
GRANT  EXECUTE ON FUNCTION public.current_staff() TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- Trigger: when a new auth.users row is created, link it to a staff row by email.
-- If no matching staff row exists, the auth user simply gets no access (no error).
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.link_auth_user_to_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  UPDATE public.staff
     SET user_id = NEW.id
   WHERE lower(email) = lower(NEW.email)
     AND user_id IS NULL
     AND is_active = true;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.link_auth_user_to_staff();

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — businesses
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY businesses_select ON public.businesses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR cs.business_id = businesses.id
    )
  );

CREATE POLICY businesses_insert ON public.businesses
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY businesses_update ON public.businesses
  FOR UPDATE TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY businesses_delete ON public.businesses
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — staff
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY staff_select ON public.staff
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = staff.business_id)
         OR cs.staff_id = staff.id
    )
  );

CREATE POLICY staff_insert ON public.staff
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager'
             AND cs.business_id = staff.business_id
             AND staff.role IN ('business_manager', 'check_in'))
    )
  );

CREATE POLICY staff_update ON public.staff
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = staff.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = staff.business_id)
    )
  );

CREATE POLICY staff_delete ON public.staff
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = staff.business_id)
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — resources
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY resources_select ON public.resources
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = resources.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
               SELECT 1 FROM public.staff_resources sr
               WHERE sr.staff_id = cs.staff_id AND sr.resource_id = resources.id))
    )
  );

CREATE POLICY resources_insert ON public.resources
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = resources.business_id)
    )
  );

CREATE POLICY resources_update ON public.resources
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = resources.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = resources.business_id)
    )
  );

CREATE POLICY resources_delete ON public.resources
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = resources.business_id)
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — resource_blocks (scoped via resources.business_id)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY resource_blocks_select ON public.resource_blocks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.resources r, public.current_staff() cs
      WHERE r.id = resource_blocks.resource_id
        AND (
          cs.role = 'owner'
          OR (cs.role = 'business_manager' AND cs.business_id = r.business_id)
          OR (cs.role = 'check_in' AND EXISTS (
                SELECT 1 FROM public.staff_resources sr
                WHERE sr.staff_id = cs.staff_id AND sr.resource_id = r.id))
        )
    )
  );

CREATE POLICY resource_blocks_write ON public.resource_blocks
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.resources r, public.current_staff() cs
      WHERE r.id = resource_blocks.resource_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = r.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.resources r, public.current_staff() cs
      WHERE r.id = resource_blocks.resource_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = r.business_id))
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — staff_resources
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY staff_resources_select ON public.staff_resources
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff s, public.current_staff() cs
      WHERE s.id = staff_resources.staff_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = s.business_id)
             OR cs.staff_id = s.id)
    )
  );

CREATE POLICY staff_resources_write ON public.staff_resources
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff s, public.current_staff() cs
      WHERE s.id = staff_resources.staff_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = s.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.staff s, public.current_staff() cs
      WHERE s.id = staff_resources.staff_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = s.business_id))
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — customers (per-business; check_in can read all in their resources' business
-- and INSERT walk-ins in that business)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY customers_select ON public.customers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role IN ('business_manager', 'check_in')
             AND cs.business_id = customers.business_id)
    )
  );

CREATE POLICY customers_insert ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role IN ('business_manager', 'check_in')
             AND cs.business_id = customers.business_id)
    )
  );

CREATE POLICY customers_update ON public.customers
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = customers.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = customers.business_id)
    )
  );

CREATE POLICY customers_delete ON public.customers
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — bookings
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY bookings_select ON public.bookings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_resources sr
              WHERE sr.staff_id = cs.staff_id AND sr.resource_id = bookings.resource_id))
    )
  );

CREATE POLICY bookings_insert ON public.bookings
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
    )
  );

CREATE POLICY bookings_update ON public.bookings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_resources sr
              WHERE sr.staff_id = cs.staff_id AND sr.resource_id = bookings.resource_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_resources sr
              WHERE sr.staff_id = cs.staff_id AND sr.resource_id = bookings.resource_id))
    )
  );

CREATE POLICY bookings_delete ON public.bookings
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — kiosks
-- A kiosk is "visible" if you can see at least one of its linked resources.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY kiosks_select ON public.kiosks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR EXISTS (
              SELECT 1
              FROM public.kiosk_resources kr
              JOIN public.resources r ON r.id = kr.resource_id
              WHERE kr.kiosk_id = kiosks.id
                AND (
                  (cs.role = 'business_manager' AND cs.business_id = r.business_id)
                  OR (cs.role = 'check_in' AND EXISTS (
                       SELECT 1 FROM public.staff_resources sr
                       WHERE sr.staff_id = cs.staff_id AND sr.resource_id = r.id))
                )
            )
    )
  );

CREATE POLICY kiosks_write ON public.kiosks
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — kiosk_resources (only owners + business_managers within their biz)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY kiosk_resources_select ON public.kiosk_resources
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.resources r, public.current_staff() cs
      WHERE r.id = kiosk_resources.resource_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = r.business_id)
             OR (cs.role = 'check_in' AND EXISTS (
                   SELECT 1 FROM public.staff_resources sr
                   WHERE sr.staff_id = cs.staff_id AND sr.resource_id = r.id)))
    )
  );

CREATE POLICY kiosk_resources_write ON public.kiosk_resources
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.resources r, public.current_staff() cs
      WHERE r.id = kiosk_resources.resource_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = r.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.resources r, public.current_staff() cs
      WHERE r.id = kiosk_resources.resource_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = r.business_id))
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Policies — audit_log (append-only; SELECT scoped by who's involved)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR cs.staff_id = audit_log.actor_staff_id
    )
  );

CREATE POLICY audit_log_insert ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.staff_id = audit_log.actor_staff_id OR cs.role = 'owner'
    )
  );
-- No UPDATE/DELETE policies → effectively forbidden under RLS (append-only).

-- ──────────────────────────────────────────────────────────────────────────────
-- Realtime publication — keep narrow to minimize CDC overhead.
-- Only bookings and kiosks are watched in real time. Add others later if needed.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.bookings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.kiosks;
