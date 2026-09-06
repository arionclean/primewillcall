-- Three more per-staff permissions, with the guards behind them.
--
--   can_view_attachments  default on   open the photos attached to a booking
--   can_redeem_groupon    default off  see Redemption Codes + the Redeem toggle
--   can_view_details      default on   off: the desk sees only ID, name, phone,
--                                      guests and check-in status
--
-- Redeem was owner-only until now, and the default keeps it that way for every
-- existing account until the owner hands it out. It is enforced here like the
-- other write permissions: the update trigger refuses a groupon_redeemed_at
-- change without it, and the update policy now admits an account that holds
-- only the peek or redeem switch (it used to require edit or check-in, which
-- left a peek-only account unable to flip peek at all).
--
-- The two view switches are about what the screen fetches and shows, not row
-- scope. RLS is row-level: a column a role may read on one booking cannot be
-- hidden from it on another, so the bookings page leaves the withheld columns
-- out of its query (bookingSelect in src/app/(app)/bookings/list.tsx) and the
-- Realtime patch drops them from change payloads. They are privacy on the
-- device, and are documented as such.
--
-- The trigger also gains a check-in guard it should always have had: without
-- can_check_in a non-owner may not touch checked_in_at, whatever else they may
-- edit. Until now the update policy's edit-or-check-in test masked the gap.

ALTER TABLE public.staff
  ADD COLUMN can_view_attachments boolean NOT NULL DEFAULT true,
  ADD COLUMN can_redeem_groupon   boolean NOT NULL DEFAULT false,
  ADD COLUMN can_view_details     boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.staff.can_view_attachments IS
  'May open the photos attached to a booking (Groupon voucher screenshots). Screen-level.';
COMMENT ON COLUMN public.staff.can_redeem_groupon IS
  'May see Redemption Codes and mark a Groupon voucher redeemed. Enforced by the bookings update trigger.';
COMMENT ON COLUMN public.staff.can_view_details IS
  'Off: the bookings screen shows only ID, name, phone, guests and check-in status. Screen-level.';

-- ── The access token carries the new columns ────────────────────────────────
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
    claims := jsonb_set(claims, '{app_staff}', 'null'::jsonb);
  ELSE
    claims := jsonb_set(claims, '{app_staff}', jsonb_build_object(
      'id',                   s.id,
      'full_name',            s.full_name,
      'role',                 s.role,
      'business_id',          s.business_id,
      'is_active',            s.is_active,
      'kiosk_slug',           s.kiosk_slug,
      'can_create_bookings',  s.can_create_bookings,
      'can_edit_bookings',    s.can_edit_bookings,
      'can_check_in',         s.can_check_in,
      'can_delete_bookings',  s.can_delete_bookings,
      'can_add_to_peek',      s.can_add_to_peek,
      'can_view_attachments', s.can_view_attachments,
      'can_redeem_groupon',   s.can_redeem_groupon,
      'can_view_details',     s.can_view_details
    ));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

-- ── bookings UPDATE: any write permission admits the row ────────────────────
DROP POLICY IF EXISTS bookings_update ON public.bookings;
CREATE POLICY bookings_update ON public.bookings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.current_staff() cs
      JOIN public.staff s ON s.id = cs.staff_id
      WHERE cs.role = 'owner'
         OR ((s.can_edit_bookings OR s.can_check_in
              OR s.can_add_to_peek OR s.can_redeem_groupon)
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
         OR ((s.can_edit_bookings OR s.can_check_in
              OR s.can_add_to_peek OR s.can_redeem_groupon)
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

-- ── Column guard: each stamp needs its own permission ───────────────────────
-- Service-role writers (webhooks, edge functions, the Xano sync) have no
-- current_staff() row and pass through untouched. Owners pass. Everyone else:
-- check-in, peek and redeem each need their switch, and without edit nothing
-- but those stamps may change.
CREATE OR REPLACE FUNCTION public.enforce_booking_update_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.staff_role;
  v_can_edit boolean;
  v_can_check_in boolean;
  v_can_peek boolean;
  v_can_redeem boolean;
BEGIN
  SELECT cs.role, s.can_edit_bookings, s.can_check_in, s.can_add_to_peek,
         s.can_redeem_groupon
    INTO v_role, v_can_edit, v_can_check_in, v_can_peek, v_can_redeem
    FROM public.current_staff() cs
    JOIN public.staff s ON s.id = cs.staff_id
   LIMIT 1;

  IF NOT FOUND OR v_role = 'owner' THEN
    RETURN NEW;
  END IF;

  IF NOT v_can_check_in
     AND (NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at
          OR NEW.checked_in_by_staff_id IS DISTINCT FROM OLD.checked_in_by_staff_id) THEN
    RAISE EXCEPTION 'Your account can''t check guests in.';
  END IF;

  IF NOT v_can_peek AND NEW.peek IS DISTINCT FROM OLD.peek THEN
    RAISE EXCEPTION 'Your account can''t change Peek status.';
  END IF;

  IF NOT v_can_redeem
     AND NEW.groupon_redeemed_at IS DISTINCT FROM OLD.groupon_redeemed_at THEN
    RAISE EXCEPTION 'Your account can''t redeem Groupon vouchers.';
  END IF;

  IF v_can_edit THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'checked_in_at' - 'checked_in_by_staff_id' - 'peek'
        - 'groupon_redeemed_at' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'checked_in_at' - 'checked_in_by_staff_id' - 'peek'
        - 'groupon_redeemed_at' - 'updated_at') THEN
    RAISE EXCEPTION 'Your account can only update check-in on bookings.';
  END IF;
  RETURN NEW;
END;
$$;
