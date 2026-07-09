-- Stripe payments: Supabase-native replication of the live Xano Connect model, so the
-- app is ready to migrate off Xano. Xano itself is NOT touched by this migration.
--
-- Model (matches Xano): Stripe Connect with DIRECT charges. Each business is a connected
-- account; a charge is created on that account with a platform application_fee. The
-- business is merchant of record; Prime (the platform) skims a configurable cut.
--
-- Adds:
--   1. Connect account fields on businesses (acct id + status flags + platform fee bps).
--   2. bookings.paid_at (payment completion timestamp).
--   3. stripe_transactions: the payment ledger (one row per Stripe charge / payment_intent,
--      deduped on stripe_id, full raw payload retained).
--   4. stripe_refunds: refund ledger (foundation for the refunds follow-up).
--   5. stripe_events: webhook idempotency + audit.
--
-- All writes to these tables happen server-side with the service role (the webhook, and
-- server actions AFTER an explicit role check), so normal roles get SELECT policies only.

-- ── businesses: Connect account fields ────────────────────────────────────────
alter table public.businesses
  add column if not exists stripe_account_id text unique,
  add column if not exists stripe_charges_enabled boolean not null default false,
  add column if not exists stripe_payouts_enabled boolean not null default false,
  add column if not exists stripe_details_submitted boolean not null default false,
  add column if not exists stripe_requirements_due integer not null default 0,
  add column if not exists stripe_account_synced_at timestamptz;

comment on column public.businesses.stripe_account_id is
  'Stripe Connect connected account id (acct_...). Charges are created directly on this account with a platform application_fee (a single global rate; see STRIPE_PLATFORM_FEE_BPS). Reused from the legacy Xano setup where present.';

-- ── bookings: payment completion timestamp ────────────────────────────────────
alter table public.bookings
  add column if not exists paid_at timestamptz;

comment on column public.bookings.paid_at is
  'When payment for this booking completed (set by the Stripe webhook). NULL while pending/unpaid.';

-- ── stripe_transactions: the payment ledger ───────────────────────────────────
create table if not exists public.stripe_transactions (
  id uuid primary key default gen_random_uuid(),
  stripe_id text not null unique,               -- charge (ch_) or payment_intent (pi_) id: dedup key
  object_type text,                             -- 'charge' | 'payment_intent'
  business_id uuid references public.businesses(id) on delete set null,
  connected_account_id text,                    -- acct_... the charge settled on
  charge_type text,                             -- 'direct' | 'destination' | 'separate'
  amount integer not null default 0,            -- gross, cents
  currency text not null default 'usd',
  stripe_fee integer not null default 0,        -- Stripe processing fee, cents (from balance txn)
  application_fee integer not null default 0,   -- platform fee, cents
  net integer not null default 0,               -- net to business, cents (from balance txn)
  amount_refunded integer not null default 0,   -- cumulative refunded, cents
  card_country text,
  card_brand text,
  status text,                                  -- succeeded | refunded | disputed | ...
  dispute_status text,
  on_behalf_of text,
  source text,                                  -- 'groupon' | 'online' | 'schedule' | 'kiosk' | ...
  booking_id uuid references public.bookings(id) on delete set null,
  booking_ref text,                             -- raw metadata.booking_id for cross-reference
  customer_email text,
  descriptor text,
  receipt_url text,
  livemode boolean,
  stripe_created timestamptz,                   -- Stripe object `created`
  raw jsonb not null,                           -- full Stripe object payload
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_transactions_business_idx on public.stripe_transactions (business_id);
create index if not exists stripe_transactions_booking_idx on public.stripe_transactions (booking_id);
create index if not exists stripe_transactions_status_idx on public.stripe_transactions (status);
create index if not exists stripe_transactions_created_idx on public.stripe_transactions (stripe_created desc);

create trigger stripe_transactions_set_updated_at before update on public.stripe_transactions
  for each row execute function public.set_updated_at();

-- ── stripe_refunds: refund ledger ─────────────────────────────────────────────
create table if not exists public.stripe_refunds (
  id uuid primary key default gen_random_uuid(),
  stripe_refund_id text not null unique,        -- re_...
  transaction_id uuid references public.stripe_transactions(id) on delete set null,
  business_id uuid references public.businesses(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  amount integer not null default 0,            -- cents
  currency text not null default 'usd',
  reason text,
  status text,
  created_by_staff_id uuid references public.staff(id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists stripe_refunds_transaction_idx on public.stripe_refunds (transaction_id);
create index if not exists stripe_refunds_business_idx on public.stripe_refunds (business_id);
create index if not exists stripe_refunds_booking_idx on public.stripe_refunds (booking_id);

-- ── stripe_events: webhook idempotency + audit ────────────────────────────────
create table if not exists public.stripe_events (
  id text primary key,                          -- Stripe event id (evt_...)
  type text not null,
  account text,                                 -- connected account for Connect events
  livemode boolean,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create index if not exists stripe_events_type_idx on public.stripe_events (type);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.stripe_transactions enable row level security;
alter table public.stripe_refunds enable row level security;
alter table public.stripe_events enable row level security;

-- Ledgers: owner sees all; business_manager sees their own business. No INSERT/UPDATE/
-- DELETE policies: the webhook and server actions write with the service role, which
-- bypasses RLS.
create policy stripe_transactions_select on public.stripe_transactions
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = stripe_transactions.business_id)
    )
  );

create policy stripe_refunds_select on public.stripe_refunds
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = stripe_refunds.business_id)
    )
  );

-- stripe_events has RLS enabled with no policies: only the service role can read/write it.
