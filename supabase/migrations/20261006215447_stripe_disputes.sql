-- Stripe disputes: a guest asked their bank for the money back.
--
-- Read by the owner's Disputes tab on /admin/payments. One row per Stripe
-- dispute, keyed on Stripe's id, so every writer converges on the same row:
--   * stripe-webhook, on charge.dispute.* (created, updated, closed,
--     funds_withdrawn, funds_reinstated);
--   * stripe-disputes `sync`, every time the Disputes tab opens (and as the
--     backfill: it pages through every account's whole history);
--   * stripe-disputes after the owner saves, submits or accepts.
--
-- The row is the list's copy: status, money, deadline, and the links to our
-- ledger. The evidence itself (text and files) lives in Stripe and is read live
-- when a dispute is opened, so a draft can never disagree with what the bank
-- will see.
--
-- `bucket` folds Stripe's eight statuses into the five the screen shows. It is a
-- generated column so the list filter, the summary and the tab's count all use
-- one definition.
--
-- Owner only (the owner's call, 2026-10-06), like Payouts. No write policy; only
-- the service role writes.

create table if not exists public.stripe_disputes (
  id                    uuid primary key default gen_random_uuid(),
  stripe_dispute_id     text not null unique,

  business_id           uuid references public.businesses (id) on delete set null,
  connected_account_id  text not null,
  charge_id             text,
  -- Our ledger row for the disputed charge, and the booking behind it, when known.
  transaction_id        uuid references public.stripe_transactions (id) on delete set null,
  booking_id            uuid references public.bookings (id) on delete set null,
  customer_name         text,

  amount                bigint not null,                    -- cents
  currency              text not null default 'usd',
  -- Stripe's own values: warning_needs_response | warning_under_review |
  -- warning_closed | needs_response | under_review | won | lost | charge_refunded
  status                text not null,
  bucket                text generated always as (
    case
      when status in ('needs_response', 'warning_needs_response') then 'needs_response'
      when status in ('under_review', 'warning_under_review') then 'under_review'
      when status = 'won' then 'won'
      when status = 'lost' then 'lost'
      else 'closed'
    end
  ) stored,
  reason                text not null,
  network_reason_code   text,
  card_brand            text,
  is_charge_refundable  boolean not null default false,

  -- The bank's deadline for evidence, and where the answer stands.
  evidence_due_by       timestamptz,
  has_evidence          boolean not null default false,
  evidence_past_due     boolean not null default false,
  submission_count      integer not null default 0,

  livemode              boolean not null default true,
  stripe_created        timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.stripe_disputes is
  'One row per Stripe dispute on a business account. Written by stripe-webhook and stripe-disputes (service role); read by the owner Disputes tab. Evidence stays in Stripe.';
comment on column public.stripe_disputes.bucket is
  'needs_response | under_review | won | lost | closed. Generated from status; the one grouping the screen, the summary and the tab count share.';

create index if not exists stripe_disputes_bucket_due_idx
  on public.stripe_disputes (bucket, evidence_due_by);
create index if not exists stripe_disputes_created_idx
  on public.stripe_disputes (stripe_created desc);
create index if not exists stripe_disputes_business_created_idx
  on public.stripe_disputes (business_id, stripe_created desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.stripe_disputes enable row level security;

drop policy if exists stripe_disputes_owner_select on public.stripe_disputes;
create policy stripe_disputes_owner_select
  on public.stripe_disputes for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- ── summary ──────────────────────────────────────────────────────────────────
-- Count and money per bucket for the tab's summary cards, summed in the database.
-- SECURITY INVOKER, so the owner-only policy above still decides what is counted.
create or replace function public.stripe_disputes_summary(p_business uuid default null)
returns table (bucket text, disputes integer, amount bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select d.bucket, count(*)::integer, coalesce(sum(d.amount), 0)::bigint
  from public.stripe_disputes d
  where p_business is null or d.business_id = p_business
  group by d.bucket
$$;

revoke execute on function public.stripe_disputes_summary(uuid) from public, anon;
grant execute on function public.stripe_disputes_summary(uuid) to authenticated;

-- ── realtime ─────────────────────────────────────────────────────────────────
-- The list and an open dispute both refresh when Stripe changes one. Subscribers
-- use no filter, so the default replica identity is enough.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stripe_disputes'
  ) then
    alter publication supabase_realtime add table public.stripe_disputes;
  end if;
end $$;
