-- "Add to Peek": staff manually enter each booking into Peek (the boat's
-- reservation system) and then stamp it here so the team can see what is
-- already in. Port of the legacy manifest's yellow per-booking toggle
-- (legacy bookings.peek boolean; new schema records when instead).

ALTER TABLE public.bookings
  ADD COLUMN added_to_peek_at timestamptz;

-- Check-in-only accounts (can_check_in without can_edit_bookings) may flip
-- the Peek stamp too: it is a desk workflow flag like check-in, not a
-- booking edit.
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

  IF (to_jsonb(NEW) - 'checked_in_at' - 'checked_in_by_staff_id' - 'added_to_peek_at' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'checked_in_at' - 'checked_in_by_staff_id' - 'added_to_peek_at' - 'updated_at') THEN
    RAISE EXCEPTION 'Your account can only update check-in on bookings.';
  END IF;
  RETURN NEW;
END;
$$;
