-- Bulk setter for the booked_at backfill.
--
-- scripts/backfill_booking_booked_at.py carries one distinct timestamp per booking, so
-- there is nothing to group into a batch: a plain PostgREST PATCH per value would be
-- ~92,000 round trips. This takes an array of {id, booked_at} and applies up to a
-- whole page in one call.
--
-- It only ever fills a NULL, so a second run writes nothing and a sale date learned
-- from the sync in the meantime is never overwritten. Service role only: it is a
-- migration tool, not something the app or a staff session calls, and RLS does not
-- apply to the service role anyway.

create or replace function public.set_booked_at_bulk(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  update public.bookings b
     set booked_at = (e->>'booked_at')::timestamptz
    from jsonb_array_elements(p_rows) e
   where b.id = (e->>'id')::uuid
     and b.booked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.set_booked_at_bulk(jsonb) from public, anon, authenticated;

comment on function public.set_booked_at_bulk(jsonb) is
  'Backfill helper for bookings.booked_at. Fills NULLs only. Service role only.';
