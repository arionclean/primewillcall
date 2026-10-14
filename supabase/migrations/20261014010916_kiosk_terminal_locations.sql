-- Kiosk card readers follow the business onto a new Stripe account.
--
-- A Stripe Terminal Location belongs to one Stripe account, and a reader can only
-- take a card for the account its Location is on. kiosks.terminal_location_id held a
-- single Location, so moving a kiosk business to its new fee-free account
-- (docs/stripe-fee-free-accounts.md) would have left its readers on the old one and
-- every card sale at the desk failing.
--
-- So the Location is now kept per kiosk PER ACCOUNT. kiosk-connection-token hands the
-- tablet the Location for whichever account the kiosk charges on right now, which
-- means the business's switch to its new account (one row update, as before) moves
-- the readers with it, and switching back moves them back. stripe-account-switch (the
-- internal switch) creates the new account's Locations, copied from the old ones,
-- before it lets the switch happen.
--
-- Written only by the edge functions (service role). Owner may read.

create table if not exists public.kiosk_terminal_locations (
  kiosk_id uuid not null references public.kiosks(id) on delete cascade,
  stripe_account_id text not null,
  location_id text not null,
  created_at timestamptz not null default now(),
  primary key (kiosk_id, stripe_account_id)
);

comment on table public.kiosk_terminal_locations is
  'The Stripe Terminal Location (tml_...) a kiosk''s readers use on each Stripe account (acct_...) it has charged on. kiosk-connection-token returns the one for the account the kiosk charges on now; stripe-account-switch creates the new account''s rows before a switch.';

-- Every kiosk's current Location, under the account it charges on today.
insert into public.kiosk_terminal_locations (kiosk_id, stripe_account_id, location_id)
select k.id, coalesce(k.stripe_account_id, b.stripe_account_id), k.terminal_location_id
from public.kiosks k
left join public.businesses b on b.id = k.business_id
where k.terminal_location_id is not null
  and coalesce(k.stripe_account_id, b.stripe_account_id) is not null
on conflict (kiosk_id, stripe_account_id) do nothing;

comment on column public.kiosks.terminal_location_id is
  'Superseded by kiosk_terminal_locations (2026-10-13) and no longer read. Kept only so a rollback of kiosk-connection-token still works; drop once that is settled.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.kiosk_terminal_locations enable row level security;

drop policy if exists kiosk_terminal_locations_owner_select on public.kiosk_terminal_locations;
create policy kiosk_terminal_locations_owner_select
  on public.kiosk_terminal_locations for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));
