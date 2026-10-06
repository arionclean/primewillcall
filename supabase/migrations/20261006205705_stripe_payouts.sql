-- Stripe payouts: the money each business's Stripe account sends to its bank.
--
-- Read by the owner's Payouts tab on /admin/payments. One row per Stripe payout,
-- keyed on Stripe's own id, so every path that writes one converges on the same
-- row:
--   * the stripe-webhook function, on payout.created / updated / paid / failed /
--     canceled (once those events are added to the Connect endpoint in Stripe);
--   * the stripe-reports function, which re-reads each account's latest payouts
--     every time the tab opens (so the list is right even before the webhook is
--     subscribed, and an in-transit payout flips to paid without anyone waiting);
--   * stripe-reports' one-time backfill, which pages through the whole history.
--
-- Only the payout itself is stored. What went INTO a payout (the sales, refunds
-- and fees) is read live from Stripe when the owner opens one: it is a few
-- hundred rows at most and nobody reads it twice, so a copy would only go stale.
-- Balance, disputes and account health are read live for the same reason.
--
-- Owner only (the owner's call, 2026-10-06): managers do not see payouts. There
-- is no write policy; only the service role (the two functions above) writes.

create table if not exists public.stripe_payouts (
  id                    uuid primary key default gen_random_uuid(),
  stripe_payout_id      text not null unique,

  -- Null only if the account cannot be matched to a business (an account that
  -- was never linked). The live account and stripe_account_id_legacy both match.
  business_id           uuid references public.businesses (id) on delete set null,
  connected_account_id  text not null,

  amount                bigint not null,                   -- cents
  currency              text not null default 'usd',
  -- pending | in_transit | paid | failed | canceled (Stripe's own values)
  status                text not null,
  -- The day Stripe expects the money in the bank. Stripe sends it as midnight UTC
  -- of that day, so it is stored as the plain date, never shifted to New York.
  arrival_date          date not null,
  automatic             boolean not null default true,
  method                text,                               -- standard | instant

  -- Where it went. bank_name / bank_last4 come from the external account the
  -- payout names, read once per sync, so the list can say "Chase •••• 1234".
  destination_id        text,
  bank_name             text,
  bank_last4            text,

  failure_code          text,
  failure_message       text,
  statement_descriptor  text,

  livemode              boolean not null default true,
  stripe_created        timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.stripe_payouts is
  'One row per Stripe payout to a business bank account. Written by stripe-webhook and stripe-reports (service role); read by the owner Payouts tab.';

create index if not exists stripe_payouts_arrival_idx
  on public.stripe_payouts (arrival_date desc, stripe_created desc);
create index if not exists stripe_payouts_business_arrival_idx
  on public.stripe_payouts (business_id, arrival_date desc, stripe_created desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.stripe_payouts enable row level security;

drop policy if exists stripe_payouts_owner_select on public.stripe_payouts;
create policy stripe_payouts_owner_select
  on public.stripe_payouts for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- ── realtime ─────────────────────────────────────────────────────────────────
-- The Payouts tab refreshes when a payout lands or changes status. It subscribes
-- without a filter, so the default replica identity is enough.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stripe_payouts'
  ) then
    alter publication supabase_realtime add table public.stripe_payouts;
  end if;
end $$;
