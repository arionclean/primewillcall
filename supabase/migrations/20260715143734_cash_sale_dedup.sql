-- Recovered on 2026-09-17 from the database's migration log (applied 2026-07-15
-- 14:37 UTC). It only ever lived on the feat/stripe-completion branch, although
-- kiosk-cash-sale and kiosk-cash-sweep on main upsert on this key. Verbatim what ran.

alter table public.cash_sales
  add column if not exists dedup_key text;

comment on column public.cash_sales.dedup_key is
  'Idempotency key for the kiosk cash-sale write: the app''s idempotency_key (booking id + type), else kiosk:booking_ref:amount_cents. Upsert target so a retried shadow write cannot double-insert.';

create unique index if not exists cash_sales_dedup_key_key
  on public.cash_sales (dedup_key);
