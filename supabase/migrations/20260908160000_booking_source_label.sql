-- Booking source, readable, on every bookings read.
--
-- The owner wants the bookings list to say where a booking came from (Viator,
-- Groupon, a website widget, the kiosk) instead of the ID, which is copied, not
-- read. `bookings.source_channel` holds the raw channel name and the owner-edited
-- `booking_source_labels` table says how to show it; /analytics already joins the
-- two. This exposes the same answer as a computed column, `source_label`, so the
-- list adds one name to its select and never carries the mapping in JavaScript.
--
-- Two functions: `booking_source_label(text)` is the rule (label if there is one,
-- else the raw channel, else "Direct"), and `source_label(bookings)` is the
-- PostgREST computed column (a function named after the column that takes the row
-- type). Both run as the caller: the labels table is readable by every active
-- staffer and the bookings row is already theirs by RLS, so nothing new is exposed.
-- The lookup hits the case-insensitive unique index on booking_source_labels.

create or replace function public.booking_source_label(p_channel text)
returns text
language sql
stable
set search_path to 'public'
as $$
  select coalesce(
    (select l.label
       from booking_source_labels l
      where lower(l.channel) = lower(btrim(p_channel))
      limit 1),
    nullif(btrim(p_channel), ''),
    'Direct'
  )
$$;

comment on function public.booking_source_label(text) is
  'How a raw bookings.source_channel is shown to staff: its booking_source_labels label, else the raw value, else Direct.';

create or replace function public.source_label(b public.bookings)
returns text
language sql
stable
set search_path to 'public'
as $$
  select public.booking_source_label(b.source_channel)
$$;

comment on function public.source_label(public.bookings) is
  'PostgREST computed column: select "source_label" on bookings to get booking_source_label(source_channel).';

grant execute on function public.booking_source_label(text) to authenticated;
grant execute on function public.source_label(public.bookings) to authenticated;
