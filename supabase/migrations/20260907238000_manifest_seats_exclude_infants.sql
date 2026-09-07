-- Check-in counts are seats: adults + children. Infants ride on a lap and do
-- not take a seat, so the manifest (sidebar per-departure remaining / totals)
-- and the bookings page headers no longer count them. The row still shows the
-- infant count in its own slot ("/2"), and analytics keeps counting every
-- guest, since that is a different question (how many people came).

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
SET search_path TO 'public'
AS $$
  SELECT b.starts_at,
         COALESCE(SUM(b.pax_adult + b.pax_child)
                    FILTER (WHERE b.checked_in_at IS NULL), 0)::bigint,
         COALESCE(SUM(b.pax_adult + b.pax_child), 0)::bigint
    FROM public.bookings b
   WHERE b.starts_at >= p_start
     AND b.starts_at <  p_end
     AND b.status <> 'cancelled'
   GROUP BY b.starts_at
   ORDER BY b.starts_at;
$$;
