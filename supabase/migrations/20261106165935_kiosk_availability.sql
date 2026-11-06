-- Seats left on every departure of one New York day, for the tablet's Availability
-- tab (kiosk-availability, tablet build 29+). One row per active time of every tour
-- some business sells. Seats are counted the way capacity alerts count them
-- (adults plus children, every business, cancelled and unpaid checkouts skipped),
-- summed here so the function never reads booking rows.
CREATE OR REPLACE FUNCTION public.kiosk_availability(p_day date)
RETURNS TABLE (tour_id uuid, tour_name text, capacity integer, start_time time, booked integer, closed boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH seats AS (
    SELECT bt.tour_id,
           (b.starts_at AT TIME ZONE 'America/New_York')::time AS start_time,
           SUM(b.pax_adult + b.pax_child)::integer AS booked
      FROM public.bookings b
      JOIN public.business_tours bt ON bt.id = b.business_tour_id
     WHERE b.starts_at >= (p_day::timestamp AT TIME ZONE 'America/New_York')
       AND b.starts_at < ((p_day + 1)::timestamp AT TIME ZONE 'America/New_York')
       AND b.status <> 'cancelled'
       AND b.awaiting_payment = false
     GROUP BY 1, 2
  )
  SELECT t.id, t.name, t.capacity, ts.start_time, COALESCE(s.booked, 0),
         EXISTS (
           SELECT 1 FROM public.tour_slot_closures c
            WHERE c.tour_id = t.id AND c.closed_on = p_day AND c.start_time = ts.start_time
         )
    FROM public.tours t
    JOIN public.tour_timeslots ts ON ts.tour_id = t.id AND ts.is_active
    LEFT JOIN seats s ON s.tour_id = t.id AND s.start_time = ts.start_time
   WHERE EXISTS (SELECT 1 FROM public.business_tours bt WHERE bt.tour_id = t.id AND bt.is_active)
   ORDER BY t.name, ts.start_time;
$$;

-- Only the kiosk function calls it, with the service role.
REVOKE ALL ON FUNCTION public.kiosk_availability(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_availability(date) TO service_role;
