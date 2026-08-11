-- Correction to booking_peek: bookings.peek (boolean) already exists in the
-- live database and is what the Xano sync carries, so the UI uses it as the
-- single source of truth. Drop the redundant timestamp added a moment ago
-- and point the capability guard at peek instead.

ALTER TABLE public.bookings
  DROP COLUMN IF EXISTS added_to_peek_at;

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

  -- Check-in-only accounts may flip the desk workflow flags, nothing else.
  IF (to_jsonb(NEW) - 'checked_in_at' - 'checked_in_by_staff_id' - 'peek' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'checked_in_at' - 'checked_in_by_staff_id' - 'peek' - 'updated_at') THEN
    RAISE EXCEPTION 'Your account can only update check-in on bookings.';
  END IF;
  RETURN NEW;
END;
$$;
