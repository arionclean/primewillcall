# Kiosk card flow v2 (sale first, Stripe decides)

Why this exists: on 2026-09-04 a kiosk3 customer was charged $80.25 twice. The card
reader captured the first payment, the tablet reported a failure, staff re-ran the card
under a new sale reference, and nothing anywhere recorded the first charge. Root cause
write-up and evidence: memory note `project_kiosk_orphan_charges` and the Sep 4 event
timeline in `stripe_transactions` (charges KS-G9C36P6U and KS-BVTTUP03 with no sale).

The old flow (`v1`, still what every kiosk runs until flipped) charges first and only
writes the sale after staff complete a name form that appears once the money has moved.
Any interruption between those two moments loses the sale. `v2` inverts the order and
makes Stripe the only authority on outcomes.

## The flow

1. Quick Sale, card: the guest details form comes **before** the card (same form the cash
   flow already uses, button reads "Continue to Card"). If the reader battery is below the
   kiosk's block threshold the sale does not start ("Plug it in, or take cash").
2. Payment screen calls **`kiosk-sale-start`** with the whole sale: KS reference, amount,
   customer, pax and the exact Xano record the tablet used to post itself. The server:
   - writes a **hidden pending booking** through `xano-booking-sync` (`status pending`,
     `awaiting_payment = true`, so `bookings_select` hides it from every staff screen and
     from the analytics RPCs until paid);
   - creates the **PaymentIntent** as a direct charge on the kiosk's connected account with
     the platform fee, `Idempotency-Key = the KS reference`, metadata
     `booking_id = <KS>`, `kiosk_flow = v2`, `sale_id`;
   - inserts the **`kiosk_sales`** row tying them together.
   Only then does the tablet ask the reader for the card.
3. Whatever the reader says, the tablet calls **`kiosk-sale-complete`**. The server retrieves
   the intent from Stripe and acts on **its** status: `succeeded` completes the sale, anything
   else is reported back so the tablet retries on the **same** intent. The reader's own error
   is logged, never trusted for money.
4. **Completion** (`completeSale` in `_shared/kiosk-sale.ts`) is one guarded UPDATE
   (`status pending -> paid`), so the tablet and the sweep can race and only one writes:
   booking `confirmed` + `paid_at` + `awaiting_payment false`; a `cash_sales` row
   (`type card`, `dedup_key <KS>:card`, the same shape the old app's shadow write produced);
   the **Xano mirror**; `heal_ledger_booking_links` so the Stripe charge in the ledger carries
   the guest's name.
5. **`kiosk-sale-sweep`** (pg_cron, every minute, `x-cron-secret`) completes any pending sale
   older than a minute whose intent succeeded (the tablet died), cancels intents that never
   saw a card after 30 minutes and marks those sales `abandoned` (the hidden booking stays
   hidden), and retries a failed Xano mirror for 24 hours.

## Why a double charge cannot happen in v2

- **One reference, one intent.** Retrying the same sale returns the same intent (Stripe
  idempotency key = the reference). The tablet never creates an intent itself.
- **Errors are checked, not believed.** After any reader or SDK error the tablet asks the
  server, the server asks Stripe. A captured payment shows as paid and prints a receipt.
- **A crash cannot orphan a payment.** The sale exists before the card is read; the sweep
  finishes it. And a *new* sale started on that kiosk within five minutes for the same amount
  and first name, while the earlier captured sale was never acknowledged by any tablet, is
  **attached** to that payment (`completed_by = reuse`) instead of charging again. Two
  different customers paying the same amount seconds apart both get acknowledged sales, so
  they never match (`canReuseSale`, unit-tested).
- **Existing-booking card payments** (the Bookings screen's "pay by card") keep the v1 calls
  but, on a v2 kiosk, verify the intent with Stripe after an error before showing "failed".

## The switch and the rollout

`kiosks.card_flow` is the switch, per kiosk login (`'v1'` default, `'v2'`). The tablet reads
it through **`kiosk-config`** at login and on every return to the foreground and caches the
last answer, so a network blip at launch cannot drop a v2 kiosk back to v1. An old build
never calls `kiosk-config`, ignores the column and keeps the v1 flow untouched.

Rollout: the backend is already live and inert (nothing calls the new functions until a v2
build does). Install the new build on one iPad through TestFlight, flip that kiosk with

```sql
update kiosks set card_flow = 'v2' where slug = 'kiosk3';
```

and flip it back to `'v1'` to roll back without reinstalling. Two iPads share a kiosk login:
the one on the old build ignores the switch, the updated one follows it.

Battery thresholds are per kiosk too: `reader_block_battery_pct` (card sales refuse to start,
"Plug it in, or take cash", default 10) and `reader_low_battery_pct` (default 25; only logged
as a warning in `kiosk_events`, nothing on screen). The staff screens show no battery
indicator on purpose: the block is the safeguard, and staff do not need the number.

## Xano mirror (a Xano write, deliberately)

In v1 the tablet posts every card sale to Xano itself (`api:2k2IsvEZ/booking`, then
`api:_o9979qq/cash_sales`). In v2 the **server** posts the identical records instead, once
Stripe has confirmed, so Bubble's manifests keep seeing every card sale even when the tablet
died mid-sale. It is the same write, from a different client. `KIOSK_V2_XANO_MIRROR=false`
(function secret) stops it. Xano's own trigger then syncs that booking back through
`xano-booking-sync`, which converges on the row v2 created (same `legacy_id`, the KS code).
Known, pre-existing: that round trip stores kiosk prices under $100 as cents times 100
(`total_cents`), because the Xano lambda treats a cents value under 10000 as dollars.

## Logs: `kiosk_events`

Every tablet running the new build streams what it sees through **`kiosk-log`** (batched,
queued on disk, never awaited): `app_launch`, `reader_connected`, `reader_disconnected`
(with the SDK reason: `bluetoothSignalLost`, `criticallyLowBattery`, `idlePowerDown` ...),
`reader_reconnecting`/`reader_reconnected`/`reader_reconnect_failed`, `reader_battery`
(on 5% steps), `reader_low_battery`, `sale_details_entered`, `sale_start`, `card_confirmed`,
`card_error` (with the SDK message), `card_recovered_after_error`, `sale_paid_shown`,
`sale_blocked_low_battery`. The server adds `sale_started`, `card_result`, `sale_completed`,
`sale_reused`, `sale_abandoned`, `xano_mirrored`/`xano_mirror_failed`, `config_fetched`.
All rows carry `kiosk_slug`, `app_build`, a stable `device_id` per iPad and, when they belong
to a sale, `ref` (the KS code), which is also `kiosk_sales.ref`, `cash_sales.booking_ref`,
`bookings.legacy_id` and `stripe_transactions.booking_ref`. One query answers "what happened
to KS-XXXXXXXX":

```sql
select at, event, level, payload from kiosk_events where ref = 'KS-XXXXXXXX' order by at;
```

The table is in the `supabase_realtime` publication for a future live kiosks screen.

## Pieces

| Where | What |
|---|---|
| `supabase/migrations/20260907152133_kiosk_card_flow_v2.sql` | `kiosks.card_flow` + battery thresholds, `kiosk_sales`, `kiosk_events`, RLS, realtime, the sweep cron |
| `supabase/functions/_shared/kiosk-sale.ts` (+ `.test.ts`) | Stripe REST helpers, date parsing, pending booking, Xano mirror, idempotent completion, reuse rule |
| `kiosk-config`, `kiosk-sale-start`, `kiosk-sale-complete`, `kiosk-sale-sweep`, `kiosk-log` | the five functions (JWT off; `config.toml`) |
| PrimeKiosk `src/config/backend.ts` | `fetchKioskConfig`, `getCardFlow`, `kioskSaleStart`, `kioskSaleComplete` |
| PrimeKiosk `src/services/KioskLog.ts`, `src/context/ReaderStatusContext.tsx` | event queue, reader and battery state (events + the block, no on-screen indicator) |
| PrimeKiosk `QuickSaleScreen.tsx`, `PaymentScreen.tsx`, `App.tsx` | the v2 paths, gated on `getCardFlow() === 'v2'` |

Secrets used: `STRIPE_SECRET_KEY`, `XANO_WEBHOOK_SECRET`, `CRON_SECRET`, optional
`KIOSK_SHARED_SECRET`, `STRIPE_PLATFORM_FEE_BPS`, `KIOSK_V2_XANO_MIRROR`.

## Edge cases, decided

- **A reference is one sale at one price.** `kiosk-sale-start` refuses a different amount
  on an existing reference (`amount_mismatch`); the app generates a fresh reference on every
  Book tap, so a price edit is always a new sale.
- **Supabase unreachable:** v2 card sales stop (no Xano failover on purpose, since a charge
  without a recorded sale is the thing we are removing). Cash keeps working. v1 kiosks are
  unaffected.
- **Reuse is two-tiered:** under two minutes a matching amount on an unacknowledged captured
  payment is enough; two to five minutes also needs the first name (prefix tolerant). Past
  five minutes never.
- **Abandon only after Stripe confirms the cancel.** The sweep marks a sale abandoned only
  when the cancel returns `canceled`; an intent still able to succeed stays pending.
- **Mirror retries never duplicate a Xano booking.** The booking post and the cash_sales post
  are resumable separately; a booking post whose reply carried no id is left flagged for a
  person instead of retried.
- **After a completed card sale the Quick Sale form resets**; after a back-out only the guest
  fields clear and the counts stay.

Verified live on 2026-09-07 with a $1 test sale on kiosk1 (no card presented): start created
the hidden booking (`awaiting_payment`, correct `total_cents`, 7:00 AM New York stored as
11:00Z) and the intent; complete with a reader error answered Stripe's real status
(`requires_payment_method`); a second start resumed the same intent; the rows were then
removed and the intent cancelled.

## Not in v2 (on purpose)

- Cash sales are unchanged: the tablet still writes Xano and shadows to Supabase as before.
- Voids and refunds done in the Xano app still do not reach `cash_sales` (separate gap).
- No owner alerting yet; the events are there to build it on.
