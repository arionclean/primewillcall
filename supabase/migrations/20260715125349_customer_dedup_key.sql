-- Recovered on 2026-09-17 from the database's migration log (applied 2026-07-15
-- 12:53 UTC). It only ever lived on the feat/stripe-completion branch, although the
-- kiosk functions on main (kiosk-booking, _shared/kiosk-sale.ts) upsert on this key.
-- Verbatim what ran.

alter table public.customers
  add column if not exists dedup_key text;

comment on column public.customers.dedup_key is
  'Deterministic dedup key for parallel writers: business_id:norm(full_name):norm(phone) (norm = lowercase + strip non-alphanumeric). New writers upsert on this; legacy rows stay null. See docs/booking-dual-write.md.';

create unique index if not exists customers_dedup_key_key
  on public.customers (dedup_key)
  where dedup_key is not null;
