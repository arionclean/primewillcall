# Stripe: getting off platform-paid Connect fees

Prime pays Stripe a **Connect fee** on every connected account: $2 in any month the
account pays out, plus 0.25% + $0.25 per payout. This document is how we stop paying it
without disturbing anything that takes money today.

## Why we pay it

Every account in the fleet was created with `type: "express"`. That shorthand assigns
`controller.fees.payer = "application_express"`, which is Stripe's "the platform is
billed" bucket. The fee is not attached to the Express dashboard, or to direct charges,
or to our volume. It is attached to that one property.

## What replaces it

Creating the account with **controller properties** instead of `type` lets us keep
everything the business sees and move the fee off Prime:

| Property | Value | Effect |
| --- | --- | --- |
| `stripe_dashboard.type` | `express` | Business keeps the same Express dashboard |
| `fees.payer` | `account` | Stripe bills the business. **No Connect fee to Prime** |
| `losses.payments` | `stripe` | Stripe carries negative balances, not Prime |
| `requirement_collection` | `stripe` | Stripe still runs onboarding and KYC |

Stripe's wording for `fees.payer = account`: "Stripe collects fees directly from your
connected account. We don't charge any Connect fees to it or to your platform."

Nothing else moves. The business already paid Stripe's 2.9% + 30c processing fee under
Express (see Stripe's [fee payer behavior table](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior);
`application_express` bills processing to the connected account). Prime's
`application_fee_amount` is unaffected. Stripe lists this exact shape as a recommended
configuration for direct charges.

One consequence worth naming: our platform fee (`STRIPE_PLATFORM_FEE_BPS`, 0.25%) was
sized to pass the Connect fee through. On a migrated account Prime pays no Connect fee,
so that 0.25% becomes margin. Keeping, cutting, or re-pricing it is a business decision;
the code does not assume either way.

## Why every business needs a new account

`controller.stripe_dashboard.type` is immutable, and Stripe does not convert an account
between configurations. Each business needs a new `acct_` and one pass through
onboarding. Stripe's **networked onboarding** reuses the details the person already
verified on the old account, so in practice it is confirm-and-accept rather than
re-uploading documents.

## The per-business runbook

All of it lives on `/admin/businesses/[id]` under **Payments**, owner-only.

1. **Refresh status.** Fills `stripe_fees_payer`. If the badge reads "Prime is billed
   Stripe's fees", this business is worth migrating.
2. **Create replacement account.** Creates the new fee-free account and parks it in
   `businesses.stripe_account_id_pending`. It takes no payments. The live account keeps
   handling every charge, so this step is safe to do at any time of day.
3. **Send the business through onboarding.** The same Stripe hosted flow as the first
   time. "Continue onboarding" reopens it if they stop halfway.
4. **Switch over.** Enabled only once Stripe reports `charges_enabled` on the new
   account. It moves the old id into `stripe_account_id_legacy` and makes the new one
   `stripe_account_id`. From the next request, every charge path uses it.
5. **Leave the old account open** until its remaining balance pays out. Do not delete it.

Step 4 is reversible: each retired account is listed with a **Send payments back here**
button that points the business at it again, which is why the old id is kept rather than
dropped. That button is also the only way an account id is ever chosen by hand, and it
can only pick one of this business's own previous accounts. There is deliberately no
free-text "paste an `acct_...`" field anywhere: every account the app writes comes from
Stripe itself or from `stripe_account_id_legacy`.

## Why the cutover is safe

- **One source of truth.** Everything that charges (`/gp`, `/schedule`, payment links,
  the kiosk endpoints, the webhook) resolves the account from
  `businesses.stripe_account_id`. Nothing branches on account type or holds its own copy.
- **Old refunds keep working.** The refund action routes by
  `stripe_transactions.connected_account_id`, the account a charge actually settled on,
  never by the business's current account. Charges taken on the old account stay
  refundable after the switch.
- **No dead window.** Both accounts exist at once and the switch is a single row update
  gated on `charges_enabled`, so there is no moment where charges point at an account
  that cannot take them.
- **Webhooks need no change.** Connected-account events from both accounts arrive at the
  same `/api/stripe/webhook` endpoint.
- **In-flight Checkout links** created before the switch still complete on the old
  account, and the webhook still records them.

## Not done yet: kiosk Terminal

Stripe Terminal **Locations and registered readers belong to an account**, so a business
that runs a PrimeKiosk tablet needs, after its switch:

1. A Terminal Location created on the new account.
2. `kiosks.terminal_location_id` (and `kiosks.stripe_account_id` where it overrides the
   business) pointed at it.
3. Each physical reader re-registered against the new Location.

This is deliberately not built or automated yet: there are no new accounts to create
Locations on. Until a kiosk business is migrated, `/api/kiosk/*` keeps resolving the
account through `src/lib/kiosk/resolve.ts` exactly as before. Do the switch for
non-kiosk businesses first.

## Schema

Added by `supabase/migrations/20260814090000_stripe_fee_free_accounts.sql`:

- `businesses.stripe_account_id_pending` (text, unique): the new account while it
  onboards. Takes no charges.
- `businesses.stripe_account_id_legacy` (text[], default `{}`): retired accounts,
  oldest first. Reference only.
- `businesses.stripe_fees_payer` (text): `controller.fees.payer` of the live account,
  synced from Stripe. `account` = fee-free. `application*` = Prime is billed. NULL until
  the first status refresh.

## Code

- `connectControllerParams()` in `src/lib/stripe/server.ts` is the single definition of
  the account shape. Do not reintroduce `type: "express"`.
- `startFeeFreeMigration` / `switchToPendingAccount` / `cancelFeeFreeMigration` /
  `switchToLegacyAccount` in `src/app/(app)/admin/businesses/[id]/payments-actions.ts`
  are owner-only and re-check the role before writing. `switchToLegacyAccount` accepts
  only an id already in this business's `stripe_account_id_legacy`.
- New businesses created through "Set up payments" already use the fee-free shape, so
  only the existing fleet needs the migration.
