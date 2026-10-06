-- Recovered on 2026-09-17 from the database's migration log (applied 2026-06-03
-- 15:36 UTC). Replaces the partial unique index from the scaffolding migration with
-- a full one: this is the index the Xano sync upserts on, and the shape that is live
-- (20260908170000_bookings_legacy_id_prefix_index refers to it as "the unique btree
-- on legacy_id"). Verbatim what ran.

drop index if exists bookings_legacy_id_key;
create unique index bookings_legacy_id_key on bookings(legacy_id);
