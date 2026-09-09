-- Split the Bayside source bucket: four brands were showing as one.
--
-- The 20260907234000 seed folded every Miami boat channel into
-- "Miami Bayside Boat Tour - Website". Four of them are separate businesses to
-- the owner, so analytics and the bookings list both under-reported Bayside and
-- hid the others. Confirmed with the owner on 2026-09-08:
--   Default Channel and Miami Boat Tours - Website        -> Miami Boat Tours
--   Miami Star Island and Miami Star Island Cruises       -> Miami Star Island Cruises
--   www.miamicelebrityboattours.com - Website             -> Miami Celebrity Boat Tours
--   Miami Bayside Boat Tour (+ the raw channel of the same name) stays Bayside
--
-- Display only. No booking row changes: bookings.source_channel still holds what
-- the booking system sent, and RLS, the Redeem chip and the Xano mirror all keep
-- keying on that raw value. The fix applies to old and new bookings alike.
--
-- Left alone on purpose: "Miami Boat Tours/ Bayside Kiosk - Website" (1 booking,
-- last used 2025-10-10). The name claims both brands and one booking is not worth
-- a guess, so it stays on Bayside until the owner says otherwise.

insert into public.booking_source_labels (channel, label) values
  ('Default Channel',                            'Miami Boat Tours - Website'),
  ('Miami Boat Tours - Website',                 'Miami Boat Tours - Website'),
  ('Miami Star Island',                          'Miami Star Island Cruises - Website'),
  ('Miami Star Island Cruises',                  'Miami Star Island Cruises - Website'),
  ('www.miamicelebrityboattours.com - Website',  'Miami Celebrity Boat Tours - Website')
on conflict (channel) do update
  set label = excluded.label, updated_at = now();
