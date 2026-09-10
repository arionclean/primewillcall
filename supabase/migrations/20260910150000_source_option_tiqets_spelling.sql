-- The Schedule form offered "Tiquets.com", which is a misspelling of Tiqets.
--
-- The OTA writes "www.tiqets.com" / "www.tiqets.com/en/" on its bookings, and
-- both are labelled "Tiqets". A staffer picking the dropdown option would have
-- written "Tiquets.com" instead, which is nobody's spelling of the brand, so
-- the booking would have shown as its own source next to Tiqets. It would also
-- have counted as Organic rather than OTA, because classifySource() in
-- src/lib/source-type.ts looks for "tiqets" and that string does not contain it.
--
-- No booking ever used the option (0 rows), so this is a rename with nothing to
-- migrate. The option now carries the brand name staff already see in analytics,
-- and a label row makes the mapping explicit rather than a lucky string match,
-- the same way Viator, Groupon and Civitatis are handled.

update public.booking_source_options
   set channel = 'Tiqets', updated_at = now()
 where channel = 'Tiquets.com';

insert into public.booking_source_labels (channel, label) values
  ('Tiqets', 'Tiqets')
on conflict (channel) do update
  set label = excluded.label, updated_at = now();
