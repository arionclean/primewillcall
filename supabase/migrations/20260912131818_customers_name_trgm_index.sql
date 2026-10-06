-- Customer name lookup: the single heaviest query on the database.
--
-- `xano-booking-sync`'s findOrCreateCustomer asks "does this person already
-- exist?" for every incoming booking, matching the name case-insensitively:
--
--   select id, full_name, phone from customers
--   where business_id = $1 and full_name ilike $2 limit 50
--
-- No btree index can serve ILIKE, so every call sequential-scanned all 94,090
-- customer rows: 84,215 calls at ~300 ms each, 46% of all database time
-- (measured 2026-09-11, the night the instance ran out of CPU and Auth started
-- returning 504s).
--
-- A trigram GIN index serves ILIKE directly, including the leading-wildcard
-- patterns the top bar search (components/app/global-search.tsx) and the
-- Customers list use, so all three get the same win. Additive only: no query
-- and no behaviour changes, the planner just stops reading the whole table.

create extension if not exists pg_trgm with schema extensions;

create index if not exists customers_full_name_trgm_idx
  on public.customers using gin (full_name extensions.gin_trgm_ops);
