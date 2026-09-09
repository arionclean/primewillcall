-- Backfill: card refunds that never reached the sales ledger.
--
-- A card sale is written to two tables: stripe_transactions (the money) and
-- cash_sales (the sales ledger the kiosk day totals and the reconciliation read).
-- Refunding only ever wrote the first, so a refunded card sale kept showing its
-- full value and inflated that kiosk's day. Cash refunds were never affected:
-- refund_cash writes the ledger row itself.
--
-- Found while comparing 7 days of kiosk sales against Xano on 2026-09-09: Xano
-- drops the sale when it is refunded, we kept it at full value, so Sep 6 read
-- $171.20 high on kiosk1.
--
-- Seven sales, $1,041.11, between 2026-07-26 and 2026-09-06. Every one of them
-- was refunded from Stripe's own dashboard rather than through our screen (no
-- stripe_refunds row exists for any of them), which is why the webhook half of
-- the fix matters as much as the app half. Both now call syncCardRefundToLedger
-- in supabase/functions/_shared/sale-refund.ts, so this is a one-off.
--
-- The rows stay visible and still 'success'. A fully refunded sale nets to zero
-- but staff can still see it happened. refunded_at is taken from when the webhook
-- recorded the refund, which is the closest thing we have to when it was issued.

update public.cash_sales cs
set amount_refunded_cents = least(st.amount_refunded, cs.amount_cents),
    refunded_at           = coalesce(cs.refunded_at, st.updated_at)
from public.stripe_transactions st
where st.booking_ref = cs.booking_ref
  and cs.type = 'card'
  and cs.status = 'success'
  and cs.voided_at is null
  and st.amount_refunded > 0
  and coalesce(cs.amount_refunded_cents, 0) <> least(st.amount_refunded, cs.amount_cents);
