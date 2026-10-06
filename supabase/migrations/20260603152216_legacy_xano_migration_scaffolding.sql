-- Recovered on 2026-09-17 from the database's own migration log
-- (supabase_migrations.schema_migrations, applied 2026-06-03 15:22 UTC). The file
-- never reached main, so main had no CREATE for bookings_legacy_raw and none of the
-- three unique legacy indexes, although 20260609120000_secure_bookings_legacy_raw
-- and the Xano sync depend on them. Everything below is verbatim what ran, and all
-- of it is IF NOT EXISTS, so applying it anywhere is a no-op where it already holds.

-- Legacy-mapping columns so the Xano import is re-runnable (idempotent) and the
-- future one-way sync can match rows without creating duplicates. None of this
-- writes back to Xano; these just record where a row came from.

alter table businesses    add column if not exists legacy_company_id text;
alter table tours         add column if not exists legacy_product_id text;
alter table tours         add column if not exists legacy_name_variations text[] not null default '{}';
alter table business_tours add column if not exists legacy_product_id text;
alter table customers     add column if not exists legacy_source text;

alter table bookings add column if not exists legacy_id text;          -- Xano booking unique_id
alter table bookings add column if not exists legacy_reference text;   -- e.g. VIA-40849127
alter table bookings add column if not exists source_channel text;     -- e.g. Viator.com, Manual

create unique index if not exists tours_legacy_product_id_key
  on tours(legacy_product_id) where legacy_product_id is not null;
create unique index if not exists businesses_legacy_company_id_key
  on businesses(legacy_company_id) where legacy_company_id is not null;
create unique index if not exists bookings_legacy_id_key
  on bookings(legacy_id) where legacy_id is not null;

-- Raw landing zone for the bookings CSV. We load the export here untouched,
-- then transform into customers + bookings. Keeping the raw copy makes the
-- import debuggable and re-runnable without re-exporting from Xano.
create table if not exists bookings_legacy_raw (
  id bigint generated always as identity primary key,
  imported_at timestamptz not null default now(),
  row jsonb not null
);
create index if not exists bookings_legacy_raw_row_gin on bookings_legacy_raw using gin (row);
