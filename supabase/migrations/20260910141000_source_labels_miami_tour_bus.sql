-- Miami Tour Bus was showing as eight sources instead of two.
--
-- The partner's raw channel arrives spelled eight ways across 516 bookings:
-- their Bokun widget writes "Miami Tour Bus - Website" (480), and staff typing
-- the booking by hand have written "Miami Tour Bus", "miami tour bus", four
-- capitalisations of "Miami Tour Bus Combo" and one "miami tour bus - boat".
-- An unlabelled channel is displayed as it was typed, so analytics listed each
-- spelling as its own source and nobody could see the partner's real volume.
--
-- Confirmed with the owner on 2026-09-10: keep TWO buckets, not one.
--   Miami Tour Bus - Website  = the partner's own online widget (480 bookings)
--   Miami Tour Bus            = everything staff entered by hand (36 bookings)
-- The product wording (combo, boat) is dropped: it says what was sold, not
-- where the booking came from.
--
-- Display only. bookings.source_channel still holds what was typed, so RLS,
-- the Xano mirror and the Redeem chip keep keying on the raw value. The match
-- is case-insensitive (unique index on lower(channel)), so one row per spelling
-- covers every capitalisation of it. Applies to old and new bookings alike.

insert into public.booking_source_labels (channel, label) values
  ('Miami Tour Bus - Website', 'Miami Tour Bus - Website'),
  ('Miami Tour Bus',          'Miami Tour Bus'),
  ('Miami Tour Bus Combo',    'Miami Tour Bus'),
  ('miami tour bus - boat',   'Miami Tour Bus')
on conflict (channel) do update
  set label = excluded.label, updated_at = now();
