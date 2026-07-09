-- Groupon "mark as redeemed" for the bookings check-in view.
--
-- Groupon (`source_channel = 'groupon'`) bookings carry the voucher photo/code in
-- `notes`; the owner redeems each voucher on Groupon's platform after the guest
-- shows up, then needs to record that it was redeemed. This replaces the manual
-- "redeemed" note with a dedicated timestamp column, mirroring `checked_in_at`:
-- a one-click toggle, and queryable for future reporting.
--
-- NULL = not yet redeemed. No RLS change: bookings row-update already covers
-- owner (full access), so setting this column needs no new policy.

alter table public.bookings
  add column if not exists groupon_redeemed_at timestamptz;

comment on column public.bookings.groupon_redeemed_at is
  'When a Groupon (source_channel = ''groupon'') voucher was marked redeemed by the owner. NULL = not redeemed.';
