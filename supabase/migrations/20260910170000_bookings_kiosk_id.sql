-- Which kiosk sold a booking, on the booking.
--
-- Analytics had to guess it: the Sources list resolved the kiosk by matching a
-- booking's legacy_id against cash_sales.booking_ref, or kiosk_sales.booking_id,
-- or a kiosk stripe_transaction. Sales have only been recorded here since
-- 2026-07-12, so every kiosk booking older than that resolved to nothing and
-- 13,509 of them (41,492 guests) piled into one row called "Kiosk (unknown)".
-- The guess also fails for a recent booking whose sale row never landed, which
-- is how a duplicate kiosk booking sat unnoticed for three days.
--
-- Xano has always known: its booking row carries `kiosk` (the Bubble kiosk id,
-- matching kiosks.xano_kiosk_id) and `supplier` (the slug, "kiosk2"). So the
-- column is filled from Xano for the history, and by xano-booking-sync for
-- every kiosk booking from now on. Every kiosk booking reaches this platform
-- through that function, the v2 card flow included, so there is one place to
-- write it.
--
-- Nullable on purpose: a booking that is not a kiosk sale has no kiosk, and a
-- kiosk we cannot resolve is left null rather than guessed.

alter table public.bookings
  add column if not exists kiosk_id uuid references public.kiosks(id);

comment on column public.bookings.kiosk_id is
  'The kiosk that sold this booking. Set by xano-booking-sync from the Xano row; null for anything not sold at a kiosk.';

-- Analytics groups kiosk bookings by kiosk, so the lookup is by kiosk within a
-- date window. Partial: only kiosk sales ever carry one.
create index if not exists bookings_kiosk_id_starts_at_idx
  on public.bookings (kiosk_id, starts_at)
  where kiosk_id is not null;
