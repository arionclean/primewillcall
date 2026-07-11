-- Kiosk POS (Stripe Terminal): Supabase-native replication of the live Xano kiosk flow so the
-- PrimeKiosk tablet can migrate off Xano. Xano is NOT touched. Builds on the Stripe Connect
-- DIRECT-charge model already in 20260709120000_stripe_payments.sql.
--
-- The tablet does two kinds of sale: card (Stripe Terminal) and cash. This migration adds:
--   1. kiosks: map each physical kiosk to a business + (optionally) a specific Stripe Connect
--      account + Terminal Location, so the connection-token / payment-intent routes know which
--      connected account to charge. The tablet sends its `kiosk` tag (its login username in the
--      legacy app), which we resolve via kiosks.slug.
--   2. cash_sales: the cash ledger the tablet writes (mirrors Xano's cash_sales, but amount is
--      stored as integer cents instead of Xano's text).
--
-- Card sales need no new table: a Terminal PaymentIntent is a direct charge, so the existing
-- Stripe webhook records it into stripe_transactions (source='kiosk') automatically.

-- ── kiosks: connect account + terminal mapping ────────────────────────────────
alter table public.kiosks
  add column if not exists business_id uuid references public.businesses(id) on delete set null,
  add column if not exists slug text,
  add column if not exists stripe_account_id text,
  add column if not exists terminal_location_id text,
  add column if not exists simulated boolean not null default false;

comment on column public.kiosks.slug is
  'Stable kiosk identifier the tablet sends as `kiosk` on connection-token / payment-intent (the device''s login username in the legacy app). Resolves to a connected account.';
comment on column public.kiosks.stripe_account_id is
  'Optional per-kiosk Connect account override (acct_...). When null, the kiosk charges its business''s businesses.stripe_account_id. Lets a kiosk keep charging its existing account during the parallel run.';
comment on column public.kiosks.terminal_location_id is
  'Stripe Terminal Location (tml_...) under the charged account, returned to the tablet to scope readers. Null until a Location is created on that account.';

create unique index if not exists kiosks_slug_key on public.kiosks (slug) where slug is not null;
create index if not exists kiosks_business_idx on public.kiosks (business_id);

-- ── cash_sales: the tablet's cash ledger ──────────────────────────────────────
create table if not exists public.cash_sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kiosk_id uuid references public.kiosks(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  booking_ref text,                              -- raw booking id the tablet sent (legacy string) until it sends Supabase uuids
  amount_cents integer not null default 0,       -- Xano stored this as text; we store integer cents
  type text not null default 'cash',             -- 'cash' | 'card' | ...
  product text,                                  -- 'ticket' | product label
  status text not null default 'success',
  source text not null default 'kiosk',
  kiosk_slug text,                               -- raw kiosk identifier the device sent, for traceability pre-migration
  created_at timestamptz not null default now()
);

create index if not exists cash_sales_business_idx on public.cash_sales (business_id);
create index if not exists cash_sales_booking_idx on public.cash_sales (booking_id);
create index if not exists cash_sales_created_idx on public.cash_sales (created_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The kiosk writes cash_sales through a server route with the service role (bypasses RLS),
-- mirroring how the Stripe webhook writes the ledger. Normal roles get SELECT only, scoped by
-- business (owner sees all; manager + check-in see their own business).
alter table public.cash_sales enable row level security;

create policy cash_sales_select on public.cash_sales
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or ((cs.role = 'business_manager' or cs.role = 'check_in') and cs.business_id = cash_sales.business_id)
    )
  );

-- ── Seed: the one confident kiosk mapping (Xano: kiosk4 -> Skyline) ────────────
-- Other kiosk -> business assignments + real Terminal Locations are confirmed before go-live
-- (see docs/DATABASE.md "Kiosk POS"). The account override is left null so the kiosk follows
-- its business's connected account (a test acct in dev, the live acct in prod).
insert into public.kiosks (name, pairing_code, status, slug, business_id, simulated)
select 'Skyline kiosk (kiosk4)', 'KIOSK4', 'active', 'kiosk4', b.id, false
from public.businesses b
where b.slug = 'miami-skyline'
on conflict (pairing_code) do nothing;
