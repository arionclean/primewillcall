-- Fifth staff capability: can_add_to_peek gates the "Add to Peek" toggle on
-- bookings, so the owner chooses who gets that option. Defaults on to keep
-- current behavior for every existing account.

ALTER TABLE public.staff
  ADD COLUMN can_add_to_peek boolean NOT NULL DEFAULT true;

-- The bookings update guard now also enforces it: without the capability a
-- non-owner cannot flip peek at all, and check-in-only accounts stay limited
-- to the check-in stamp (+ peek only when allowed).
CREATE OR REPLACE FUNCTION public.enforce_booking_update_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.staff_role;
  v_can_edit boolean;
  v_can_peek boolean;
BEGIN
  SELECT cs.role, s.can_edit_bookings, s.can_add_to_peek
    INTO v_role, v_can_edit, v_can_peek
    FROM public.current_staff() cs
    JOIN public.staff s ON s.id = cs.staff_id
   LIMIT 1;

  IF NOT FOUND OR v_role = 'owner' THEN
    RETURN NEW;
  END IF;

  IF NOT v_can_peek AND NEW.peek IS DISTINCT FROM OLD.peek THEN
    RAISE EXCEPTION 'Your account can''t change Peek status.';
  END IF;

  IF v_can_edit THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'checked_in_at' - 'checked_in_by_staff_id' - 'peek' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'checked_in_at' - 'checked_in_by_staff_id' - 'peek' - 'updated_at') THEN
    RAISE EXCEPTION 'Your account can only update check-in on bookings.';
  END IF;
  RETURN NEW;
END;
$$;
