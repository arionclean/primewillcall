-- Where a tablet READS from: Xano (today) or this platform.
--
-- The tablet's three reads (the product list, the day's bookings, the day's
-- sales) have always come from Xano. kiosk-read now answers all three from here
-- in the exact shape the screens consume, and this switch says which source a
-- given tablet uses. Same rollout shape as card_flow: flip one kiosk, watch it,
-- flip the rest, no reinstall, and flipping back is the rollback.
--
-- Writes are untouched by this. A tablet on 'supabase' still writes to both
-- systems, so nothing drifts while it reads from here.
--
-- Default 'xano', so no tablet changes behaviour until the owner turns it on.
-- An app that does not know the field ignores it and reads Xano as before.

alter table public.kiosks
  add column if not exists read_source text not null default 'xano'
  check (read_source in ('xano', 'supabase'));

comment on column public.kiosks.read_source is
  'Which system this tablet reads products, bookings and sales from: xano (default) or supabase (kiosk-read). Writes always go to both.';
