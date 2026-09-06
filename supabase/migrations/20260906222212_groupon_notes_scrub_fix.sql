-- Finish the note scrub started in groupon_voucher_codes_from_notes.
--
-- That migration removed the code segment with ' · codes? [^·]+', and the character
-- class swallowed the space before the next separator, so the voucher segment survived
-- as "Groupon redemption· voucher https://...". Same scrub, tolerant of the spacing, and
-- any separator left dangling at the end is trimmed with the whitespace.

update public.bookings
set notes = nullif(
  btrim(regexp_replace(notes, '\s*·\s*voucher \S+', '', 'g'), ' ·'),
  ''
)
where notes like 'Groupon redemption%'
  and notes ~ '·\s*voucher ';
