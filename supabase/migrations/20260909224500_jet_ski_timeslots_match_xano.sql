-- Jet Ski departure times: use the ones the business actually runs.
--
-- Found on 2026-09-09 while checking what the tablet reads from Xano against this
-- stack. Every product and every adult and child price already matched to the cent.
-- Jet Ski was the single exception, and not by a slot or two: the two lists had no
-- time in common.
--
--   Xano (correct, confirmed by the owner)   10:00, 12:00, 14:00, 16:00, 17:30
--   here (wrong)                             12:30, 14:30, 16:30
--
-- Nothing references a timeslot row: bookings carry their own starts_at, and
-- tour_slot_closures keys on tour_id plus date plus time. So replacing the set moves
-- no booking. The one existing Jet Ski booking at 16:30 keeps the time it was sold
-- at; it is a real departure that happened, not a slot that should now exist.
--
-- Duration stays 90 minutes, which is what the three old rows carried and what the
-- Xano product implies.

delete from public.tour_timeslots
where tour_id = (select id from public.tours where name = 'Jet Ski');

insert into public.tour_timeslots (tour_id, start_time, duration_minutes, sort_order, is_active)
select t.id, v.start_time, 90, v.sort_order, true
from public.tours t
cross join (values
  ('10:00:00'::time, 10),
  ('12:00:00'::time, 20),
  ('14:00:00'::time, 30),
  ('16:00:00'::time, 40),
  ('17:30:00'::time, 50)
) as v(start_time, sort_order)
where t.name = 'Jet Ski';
