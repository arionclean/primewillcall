# Kiosk POS migration plan (Xano -> Supabase)

Living plan for moving the PrimeKiosk tablet POS off Xano onto Supabase, running both in
parallel and flipping per-concern runtime flags, then turning Xano off. Goal: staff see no
change; each piece cuts over independently and is reversible.

Last updated 2026-07-15. Companion: [`booking-dual-write.md`](booking-dual-write.md).

## The agreed execution order (work in THIS sequence)

1. **Real-kiosk end-to-end test.** In the kiosk, long-press the Settings title and flip
   **two** flags: **Payment -> SUPABASE** and **Booking -> DUAL**. Confirm one live sale:
   PaymentIntent created in Supabase -> customer pays on the reader -> booking written to
   **Xano + Supabase** -> sale (cash or card) written to **Xano + Supabase**. Verify exactly
   one row each in `bookings`, `customers`, `cash_sales` (no duplicates), then refund.
2. **Backfill history** (only after step 1 works). Copy existing Xano history into Supabase:
   - Bookings already have the sync + a backfill path.
   - `cash_sales` has **no** sync/backfill yet -> this is net-new one-time work (copy Xano
     `cash_sales` -> Supabase `cash_sales`).
3. **History + dual-write = fully in Supabase** (past via backfill, new via the app dual-write).
4. **Switch the READS to Supabase**: sales view (`SalesScreen`) and the bookings view. Do not
   flip a read until its data is fully present in Supabase (step 2/3).
5. **Remaining cutover**: products read -> Supabase; central remote flag; login -> Supabase;
   roll the app out to all tablets; finally turn Xano off.

## Status

### Done
- **Payments**: `kiosk-connection-token` + `kiosk-payment-intent` edge functions, live and
  tested on the live Stripe accounts. `stripe-webhook` edge function records charges.
- **Booking dual-write**: `kiosk-booking` function forwards to `xano-booking-sync`
  (server-side, secret off the app); upserts booking on `legacy_id`, customer on `dedup_key`.
- **Customer dedup**: `customers.dedup_key` (`business_id:norm(name):norm(phone)`).
- **Kiosk sales**: `kiosk-cash-sale` function writes cash AND card kiosk sales into
  `cash_sales` (the `type` field distinguishes), upsert on `dedup_key`.
- **App** (PrimeKiosk, branch `feat/supabase-routing`, NOT rolled out): payment routing +
  auto-failover, booking + cash/card shadow-write, all behind flags that default to `xano`;
  hidden Settings toggle (long-press the title) to flip Payment and Booking.
- **Go-live config**: live `STRIPE_SECRET_KEY`, live business `stripe_account_id` (Key West
  `acct_1QuZjq...`, Miami Skyline `acct_1P8isq...`, Jet Ski `acct_1TivVS...`), live Terminal
  Locations on `kiosks.terminal_location_id`, Stripe webhook registered. `XANO_WEBHOOK_SECRET`
  is a project-wide Supabase secret (so `kiosk-booking` already works).

### Left
- Real-kiosk test (step 1). Cash_sales backfill (step 2). SalesScreen + bookings view reads
  (step 4). Products read, central remote flag, login, app rollout (step 5).
- Owner web app has **no** kiosk-sales view (nothing reads `cash_sales`; `/admin/payments`
  reads Stripe `stripe_transactions`, card only). Build one if owners need kiosk cash+card.
- Small: populate `business_tours.legacy_product_id` for the Jet Ski tour (so its bookings
  resolve); deploy the `xano-booking-sync` `dedup_key` edit; verify a physical reader charges
  live via Supabase.

## Reference

- **Kiosk mapping**: kiosk1 -> Key West, kiosk2/kiosk3 -> Miami Skyline, kiosk4 -> Jet Ski
  (Miami Jet Ski Tours). `kiosks.slug` = the tablet login username.
- **Two app flags** (Settings long-press): `paymentBackend` (xano | supabase, with
  auto-failover) and `bookingBackend` (xano | dual | supabase; also drives the cash/card
  shadow-write). Both default `xano`, persist on device. Central remote flag (Xano
  `/app-config`) is still a stub -> flip is per-device for now.
- **Functions** (all JWT off, base `https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/`):
  `kiosk-connection-token`, `kiosk-payment-intent`, `kiosk-booking`, `kiosk-cash-sale`,
  `stripe-webhook`. Callers send the anon key as `apikey`.
- **`cash_sales` = ALL kiosk sales** (cash + card), `type` distinguishes. Same meaning as the
  Xano `cash_sales` table.
- **Convergence keys** (never plain insert during parallel run): bookings upsert on
  `legacy_id`; customers on `dedup_key`; cash_sales on `dedup_key`.
- **Bookings also auto-sync** from Xano (a `bookings` trigger -> `sync booking to
  supabase_v1` -> `xano-booking-sync`), so bookings are doubly covered; cash_sales are not.
