-- "See full booking details" off no longer hides the booking's note.
--
-- The desk needs the note to check guests in, so every account now reads it
-- (bookingSelect in src/app/(app)/bookings/booking-select.ts). Off still
-- withholds the customer's email, the void reason and the edit form. The switch
-- stays screen-level; only its description changes.

COMMENT ON COLUMN public.staff.can_view_details IS
  'Off: the bookings screen shows only ID, name, phone, guests, notes and check-in status (no email, no void reason, no edit form). Screen-level.';
