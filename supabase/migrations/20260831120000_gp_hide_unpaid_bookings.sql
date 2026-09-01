-- Abandoned /gp checkouts must not look like bookings.
--
-- The public Groupon page creates the booking BEFORE the guest pays, because Stripe's
-- Checkout Session has to carry the booking id in its metadata for the webhook to have
-- something to confirm. A guest who opens the payment page and walks away therefore left
-- a `pending` row that staff saw in the bookings list, on the dashboard and in search,
-- while Xano (which is only mirrored once the money lands) knew nothing about it.
--
-- `awaiting_payment` marks exactly that state: we handed this guest a Stripe Checkout page
-- and are waiting for them to pay. It is set by `gp-book` only when a Checkout Session was
-- actually created, and cleared by the Stripe webhook the moment the payment succeeds.
--
-- Bookings that were never handed a payment page stay visible, which is the point of a
-- separate flag rather than "hide every pending booking":
--   * a $0 convenience fee (nothing to charge, so gp-book confirms it outright),
--   * the manual-collection fallback (Stripe down, or the business not yet onboarded),
--   * a `pending` booking synced from Xano, which staff work from as normal.
--
-- Hidden at the SELECT policy rather than in each query: the bookings list, the dashboard,
-- the manifest, global search, the analytics RPCs and the Realtime stream all read through
-- it, and one of them would eventually be written without the filter. Service-role callers
-- (gp-book, the webhook, the guest's own /booking/<token> page) bypass RLS and still see
-- the row, so the guest can come back and finish paying.
alter table public.bookings
  add column if not exists awaiting_payment boolean not null default false;

comment on column public.bookings.awaiting_payment is
  'True while a /gp guest has been handed a Stripe Checkout page and has not paid yet. '
  'Such a booking is hidden from staff by the bookings_select policy. Cleared by the '
  'stripe-webhook on payment.';

-- Unchanged from the previous policy except for the final NOT (...) clause.
drop policy if exists bookings_select on public.bookings;

create policy bookings_select on public.bookings
for select
using (
  exists (
    select 1
    from current_staff() cs(staff_id, role, business_id)
    where
      cs.role = 'owner'::staff_role
      or (cs.role = 'business_manager'::staff_role and cs.business_id = bookings.business_id)
      or (
        cs.role = 'check_in'::staff_role
        and exists (
          select 1
          from staff_tours st
          join business_tours bt on bt.tour_id = st.tour_id
          where st.staff_id = cs.staff_id and bt.id = bookings.business_tour_id
        )
      )
  )
  -- All three have to hold for a booking to be hidden, so any one of them going wrong
  -- (a webhook that failed to clear the flag, a booking confirmed some other way) leaves
  -- the row visible. Failing visible is the safe direction here.
  and not (
    bookings.awaiting_payment
    and bookings.paid_at is null
    and bookings.status = 'pending'::booking_status
  )
);

-- The /gp bookings already stranded by an abandoned checkout: unpaid, never mirrored to
-- Xano, and worth money (a $0 fee booking is confirmed outright now and must stay visible).
update public.bookings
set awaiting_payment = true
where source_channel = 'groupon'
  and status = 'pending'
  and paid_at is null
  and legacy_id is null
  and total_cents > 0;
