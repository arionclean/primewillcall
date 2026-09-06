-- Groupon codes out of the note, into their column.
--
-- Until today gp-book wrote "Groupon redemption · code X · voucher <url>" as the booking
-- note. Notes are read by every role on the bookings list, so a check-in account could
-- read the Redemption Code and open the voucher. Both now have their own columns and the
-- code is shown to the owner only, so gp-book writes a plain "Groupon redemption" from
-- now on (the Xano mirror composes the fuller note Bubble staff read from the columns).
--
-- Two fixes for the rows already written:
--  1. Codes from the note, for the bookings the first backfill missed. The Xano mirror's
--     round trip rewrites `source_channel` to "groupon-surcharge" and `legacy_reference`
--     to the GP-... reference, so 105 /gp bookings no longer looked like /gp bookings.
--     Their notes still hold the codes gp-book wrote. Same shape filter as before, so an
--     OCR misread such as "5G 100" stays out.
--  2. The code and voucher segments come out of every "Groupon redemption" note. Any
--     other text in the note is kept (the demo booking's "DEMO booking" tag, for one).

update public.bookings b
set groupon_voucher_codes = codes.list
from (
  select src.id, array_agg(btrim(u.raw) order by u.ord) as list
  from public.bookings src
  cross join lateral unnest(
    string_to_array(substring(src.notes from ' · codes? ([^·]+)'), ',')
  ) with ordinality as u(raw, ord)
  where src.notes ~ '^Groupon redemption · codes? '
    and cardinality(src.groupon_voucher_codes) = 0
    and (btrim(u.raw) ~ '^\d{6,10}$' or btrim(u.raw) ~* '^VS(-[A-Z0-9]{4}){4}$')
  group by src.id
) codes
where b.id = codes.id;

update public.bookings
set notes = nullif(
  btrim(regexp_replace(regexp_replace(notes, ' · codes? [^·]+', '', 'g'), ' · voucher \S+', '', 'g')),
  ''
)
where notes like 'Groupon redemption%'
  and notes ~ ' · (codes? |voucher )';
