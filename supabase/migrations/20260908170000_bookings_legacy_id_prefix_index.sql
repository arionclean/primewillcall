-- Prefix searches on bookings.legacy_id.
--
-- The unique btree on legacy_id serves equality (the sync's upsert key) but not a
-- prefix LIKE: the column's collation is not "C", so `legacy_id like 'ota-SB-%'`
-- (the mirror health check for echo twins) and `like 'ota-PR-%'` (the reference
-- reconciliation) scan the whole table, about two seconds on 97k rows and past the
-- 8 second statement timeout when the table is busy. Seen 2026-09-08 while the
-- product comparison and the mirror monitor ran at the same time.
--
-- text_pattern_ops sorts by byte value, which is what a left-anchored LIKE needs,
-- so the planner turns the prefix into an index range. Equality lookups keep
-- using the unique index.

create index if not exists bookings_legacy_id_prefix_idx
  on public.bookings (legacy_id text_pattern_ops);

comment on index public.bookings_legacy_id_prefix_idx is
  'Left-anchored LIKE on legacy_id (ota-SB-%, ota-PR-%, xano-%). The unique index covers equality only.';
