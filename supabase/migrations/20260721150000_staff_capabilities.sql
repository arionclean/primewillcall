-- Staff capabilities: owner-editable per-staff booking permissions.
--
-- Four booleans on staff control what a business_manager or check_in account
-- may do with bookings. Owner rows ignore them (owner always can). The owner
-- edits them on /admin/staff/[id]. Enforcement is layered: the UI hides
-- controls, server actions re-check, and these policies + trigger are the
-- guarantee.
--
--   can_create_bookings  insert bookings (check_in: only on assigned tours)
--   can_edit_bookings    update any booking field
--   can_check_in         stamp / clear checked_in_at
--   can_delete_bookings  delete bookings (default off; managers backfilled on)
--
-- can_edit_bookings=false + can_check_in=true means "check-in only": RLS
-- still allows the UPDATE row-wise, so a trigger restricts which columns may
-- change (RLS cannot express column-level rules).

ALTER TABLE public.staff
  ADD COLUMN can_create_bookings boolean NOT NULL DEFAULT true,
  ADD COLUMN can_edit_bookings   boolean NOT NULL DEFAULT true,
  ADD COLUMN can_check_in        boolean NOT NULL DEFAULT true,
  ADD COLUMN can_delete_bookings boolean NOT NULL DEFAULT false;

-- Managers could already delete; keep that. check_in could not (default false).
UPDATE public.staff SET can_delete_bookings = true
 WHERE role IN ('owner', 'business_manager');

-- ── bookings INSERT ─────────────────────────────────────────────────────────
-- New: check_in may insert when capable, scoped to their business AND a tour
-- they are assigned to (staff_tours), mirroring their read scope.
DROP POLICY IF EXISTS bookings_insert ON public.bookings;
CREATE POLICY bookings_insert ON public.bookings
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.current_staff() cs
      JOIN public.staff s ON s.id = cs.staff_id
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager'
             AND cs.business_id = bookings.business_id
             AND s.can_create_bookings)
         OR (cs.role = 'check_in'
             AND cs.business_id = bookings.business_id
             AND s.can_create_bookings
             AND EXISTS (
               SELECT 1 FROM public.staff_tours st
               JOIN public.business_tours bt ON bt.tour_id = st.tour_id
               WHERE st.staff_id = cs.staff_id
                 AND bt.id = bookings.business_tour_id))
    )
  );

-- ── bookings UPDATE ─────────────────────────────────────────────────────────
-- Row scope unchanged; now also requires edit or check-in capability.
DROP POLICY IF EXISTS bookings_update ON public.bookings;
CREATE POLICY bookings_update ON public.bookings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.current_staff() cs
      JOIN public.staff s ON s.id = cs.staff_id
      WHERE cs.role = 'owner'
         OR ((s.can_edit_bookings OR s.can_check_in)
             AND ((cs.role = 'business_manager'
                   AND cs.business_id = bookings.business_id)
                  OR (cs.role = 'check_in'
                      AND EXISTS (
                        SELECT 1 FROM public.staff_tours st
                        JOIN public.business_tours bt ON bt.tour_id = st.tour_id
                        WHERE st.staff_id = cs.staff_id
                          AND bt.id = bookings.business_tour_id))))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.current_staff() cs
      JOIN public.staff s ON s.id = cs.staff_id
      WHERE cs.role = 'owner'
         OR ((s.can_edit_bookings OR s.can_check_in)
             AND ((cs.role = 'business_manager'
                   AND cs.business_id = bookings.business_id)
                  OR (cs.role = 'check_in'
                      AND EXISTS (
                        SELECT 1 FROM public.staff_tours st
                        JOIN public.business_tours bt ON bt.tour_id = st.tour_id
                        WHERE st.staff_id = cs.staff_id
                          AND bt.id = bookings.business_tour_id))))
    )
  );

-- ── bookings DELETE ─────────────────────────────────────────────────────────
-- Was owner + manager. Now capability-gated for both non-owner roles.
DROP POLICY IF EXISTS bookings_delete ON public.bookings;
CREATE POLICY bookings_delete ON public.bookings
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.current_staff() cs
      JOIN public.staff s ON s.id = cs.staff_id
      WHERE cs.role = 'owner'
         OR (s.can_delete_bookings
             AND ((cs.role = 'business_manager'
                   AND cs.business_id = bookings.business_id)
                  OR (cs.role = 'check_in'
                      AND EXISTS (
                        SELECT 1 FROM public.staff_tours st
                        JOIN public.business_tours bt ON bt.tour_id = st.tour_id
                        WHERE st.staff_id = cs.staff_id
                          AND bt.id = bookings.business_tour_id))))
    )
  );

-- ── Column-level guard for check-in-only accounts ───────────────────────────
-- When a signed-in non-owner staffer lacks can_edit_bookings, an UPDATE may
-- only touch the check-in stamp. Service-role writers (webhooks, edge
-- functions) have no current_staff() row and pass through untouched.
CREATE OR REPLACE FUNCTION public.enforce_booking_update_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.staff_role;
  v_can_edit boolean;
BEGIN
  SELECT cs.role, s.can_edit_bookings
    INTO v_role, v_can_edit
    FROM public.current_staff() cs
    JOIN public.staff s ON s.id = cs.staff_id
   LIMIT 1;

  IF NOT FOUND OR v_role = 'owner' OR v_can_edit THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'checked_in_at' - 'checked_in_by_staff_id' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'checked_in_at' - 'checked_in_by_staff_id' - 'updated_at') THEN
    RAISE EXCEPTION 'Your account can only update check-in on bookings.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_enforce_update_capabilities ON public.bookings;
CREATE TRIGGER bookings_enforce_update_capabilities
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_update_capabilities();
