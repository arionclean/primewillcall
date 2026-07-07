-- Per-date timeslot closures for the availability board.
--
-- The recurring schedule (tour_timeslots) says when a master tour normally
-- runs. A closure row says "this departure is closed on this date": weather,
-- private charter, sold out offline, and so on. Open is the default; closing
-- inserts a row, reopening deletes it.
--
-- Rows are keyed by (tour_id, closed_on, start_time) rather than by timeslot
-- id on purpose: the tour editor saves timeslots with a replace-all strategy
-- (delete + insert), and closures must survive that.
--
-- Written from /availability (owner and business managers). Read by the public
-- /api/gp/* endpoints (service role) so closed times disappear from the
-- Groupon redemption page.

CREATE TABLE public.tour_slot_closures (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id    uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  closed_on  date NOT NULL,
  start_time time NOT NULL,
  created_by uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tour_id, closed_on, start_time)
);
CREATE INDEX tour_slot_closures_closed_on_idx ON public.tour_slot_closures(closed_on);
ALTER TABLE public.tour_slot_closures ENABLE ROW LEVEL SECURITY;

-- Any active staff can see closures (schedule and availability views need them).
CREATE POLICY tour_slot_closures_select ON public.tour_slot_closures
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role IN ('owner','business_manager','check_in')));

-- Owner can close or open any tour's times. A business manager only for master
-- tours their business is assigned to. Closing affects every business sharing
-- the tour, which mirrors reality: the departure itself is closed.
CREATE POLICY tour_slot_closures_insert ON public.tour_slot_closures
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND EXISTS (
              SELECT 1 FROM public.business_tours bt
              WHERE bt.tour_id = tour_slot_closures.tour_id
                AND bt.business_id = cs.business_id))
    )
  );
CREATE POLICY tour_slot_closures_delete ON public.tour_slot_closures
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND EXISTS (
              SELECT 1 FROM public.business_tours bt
              WHERE bt.tour_id = tour_slot_closures.tour_id
                AND bt.business_id = cs.business_id))
    )
  );
