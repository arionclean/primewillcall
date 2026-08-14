-- Stripe Connect: stop paying Stripe's Connect fees on connected accounts.
--
-- Why: accounts created with `type: "express"` are assigned
-- controller.fees.payer = `application_express`, which puts Stripe's Connect fees
-- ($2 per monthly active account + 0.25% of payout volume) on PRIME, the platform.
-- Creating the account with controller properties instead:
--
--   stripe_dashboard.type   = express   (business keeps the Express dashboard)
--   fees.payer              = account   (Stripe bills the business, not Prime)
--   losses.payments         = stripe    (Stripe carries negative balances, not Prime)
--   requirement_collection  = stripe    (Stripe still runs onboarding + KYC)
--
-- gives the identical business-facing experience with zero Connect fees for Prime
-- ("Stripe collects fees directly from your connected account. We don't charge any
-- Connect fees to it or to your platform"). Prime's application_fee is unaffected,
-- and the business already paid Stripe's processing fee under Express, so nothing
-- changes for them either.
--
-- Stripe cannot convert an existing account: controller.stripe_dashboard.type is
-- immutable, so every business needs a NEW acct_ and a re-onboarding pass (made
-- short by Stripe's networked onboarding, which reuses their verified details).
--
-- These columns let one business hold both accounts at once, so the cutover is a
-- single flip with no window where charges fail:
--
--   stripe_account_id_pending  the new fee-free account while it onboards
--   stripe_account_id_legacy   accounts it has retired, kept for reference
--   stripe_fees_payer          which pricing the LIVE account is on
--
-- Everything that takes money still reads `stripe_account_id`, so no other code
-- path changes. Refunds of old charges keep working after a switch because the
-- refund action routes by stripe_transactions.connected_account_id (the account the
-- charge actually settled on), never by the business's current account.

alter table public.businesses
  add column if not exists stripe_account_id_pending text unique,
  add column if not exists stripe_account_id_legacy text[] not null default '{}',
  add column if not exists stripe_fees_payer text;

comment on column public.businesses.stripe_account_id_pending is
  'A newly created fee-free connected account (acct_...) that is still onboarding. Takes no charges. Becomes stripe_account_id once Stripe reports charges_enabled and the owner switches over on /admin/businesses/[id].';

comment on column public.businesses.stripe_account_id_legacy is
  'Connected accounts this business has retired, oldest first. Reference only: it keeps the old Express account findable while its balance pays out. The authoritative history is stripe_transactions.connected_account_id, which is what refunds route by.';

comment on column public.businesses.stripe_fees_payer is
  'controller.fees.payer of the live account, synced from Stripe. `account` means Stripe bills the business and Prime pays no Connect fees. `application_express` / `application_custom` / `application` mean Prime is billed Stripe''s Connect fees ($2 per active account + 0.25% of payout volume) and the business should be migrated. NULL until the first status refresh.';
