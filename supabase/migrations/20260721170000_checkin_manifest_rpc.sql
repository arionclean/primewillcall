-- Check-in manifest: per-timeslot guest counts for one local day, aggregated
-- in the database (never fetch-all-and-sum in JS; a day can exceed the 1000
-- row read cap across businesses).
--
-- SECURITY INVOKER, so RLS scopes the rows: a check_in staffer only counts
-- bookings on tours assigned to them, a manager only their business, the
-- owner everything. Cancelled bookings are excluded entirely; remaining_pax
-- is the guests still to check in for that departure.

CREATE OR REPLACE FUNCTION public.bookings_checkin_manifest(
  p_start timestamptz,
  p_end   timestamptz
)
RETURNS TABLE (
  slot_start    timestamptz,
  remaining_pax bigint,
  total_pax     bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT b.starts_at,
         COALESCE(SUM(b.pax_adult + b.pax_child + b.pax_infant)
                    FILTER (WHERE b.checked_in_at IS NULL), 0)::bigint,
         COALESCE(SUM(b.pax_adult + b.pax_child + b.pax_infant), 0)::bigint
    FROM public.bookings b
   WHERE b.starts_at >= p_start
     AND b.starts_at <  p_end
     AND b.status <> 'cancelled'
   GROUP BY b.starts_at
   ORDER BY b.starts_at;
$$;
