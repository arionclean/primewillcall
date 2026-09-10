-- When the booking was actually sold, as opposed to when it departs.
--
-- Analytics answers one question today: how full is a departure. It cannot
-- answer the other one, which source is growing, because that needs the date
-- the reservation came in and we do not hold a usable one. bookings.created_at
-- is the row's birthday HERE, and 79,626 of them were born in three minutes on
-- 2026-06-03 when the Xano history was imported, with another 3,920 on
-- 2026-07-11. A "sales by month" chart off that column would show eighty
-- thousand sales on one afternoon in June and nothing before it.
--
-- Xano's own created_at is real. Bucketed by month across all 96,907 of its
-- bookings it is a smooth curve from March 2024 to today, and its busiest
-- single minute is 29 bookings, which is a good morning, not an import.
--
-- So: booked_at holds Xano's timestamp for everything that came from there,
-- and stays null for a booking born on this platform, whose own created_at is
-- already correct. Readers use coalesce(booked_at, created_at) and get the
-- right answer for both without a trigger keeping two columns in step.

alter table public.bookings
  add column if not exists booked_at timestamptz;

comment on column public.bookings.booked_at is
  'When the booking was sold, from Xano. Null for a booking born here: use coalesce(booked_at, created_at).';

-- Sales analytics group by this date over a window, the way the existing
-- reports group by starts_at.
create index if not exists bookings_booked_at_idx
  on public.bookings (booked_at)
  where booked_at is not null;
