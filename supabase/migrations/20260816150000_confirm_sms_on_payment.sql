-- Send the booking confirmation when the guest has PAID, not when the row is inserted.
--
-- The bug: trg_native_booking_automations was `AFTER INSERT ... WHEN (legacy_id IS NULL)`
-- with no payment condition. /gp inserts the booking as `pending` and only then creates the
-- Stripe Checkout Session, so the confirmation SMS went out about a second later whether or
-- not the guest ever paid. Abandoning the checkout still got you a "here is your ticket" text.
--
-- The fix is two triggers sharing the same function (it only reads NEW.id):
--
--   INSERT: fire only for a booking that is already payable-complete. /schedule creates
--           bookings as `confirmed`, so staff bookings are unaffected and still text on
--           creation. A `pending` booking now stays quiet.
--   UPDATE: fire on the pending -> confirmed transition, which is exactly what the Stripe
--           webhook does when payment_intent.succeeded / checkout.session.completed lands.
--
-- Both keep the `legacy_id IS NULL` condition, so Xano-synced bookings are still Xano's to
-- announce and we never double-text (see docs/messaging-automations.md).

drop trigger if exists trg_native_booking_automations on public.bookings;

create trigger trg_native_booking_automations
  after insert on public.bookings
  for each row
  when (new.legacy_id is null and new.status <> 'pending')
  execute function public.on_native_booking_created();

-- The payment moment. Guarded to the one transition so an ordinary edit of an already
-- confirmed booking cannot re-send.
create trigger trg_native_booking_paid
  after update on public.bookings
  for each row
  when (
    new.legacy_id is null
    and old.status = 'pending'
    and new.status = 'confirmed'
  )
  execute function public.on_native_booking_created();
