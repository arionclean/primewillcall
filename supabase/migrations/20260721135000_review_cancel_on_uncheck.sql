-- Cancel the review funnel when a booking is un-checked-in or cancelled.
--
-- Xano does this in fn 94 "add to flowList DB": if the booking comes back
-- checked = false it DELETES that booking's pending timers, because a guest
-- who was checked in by mistake must never be asked how their tour was.
--
-- This lives in the DATABASE, not in app code, for the same reason the
-- new-booking automation trigger does: unchecking is a direct browser-client
-- mutation from the bookings list (see list.tsx), and the kiosk can do it too,
-- so an app-side hook would simply be bypassed.

-- A booking going away is a second, equally good reason to stop.
alter table public.reviews
  drop constraint if exists reviews_cancel_reason_check;
alter table public.reviews
  add constraint reviews_cancel_reason_check
  check (
    cancel_reason is null
    or cancel_reason in ('unchecked', 'booking_cancelled', 'replied', 'clicked_link')
  );

create or replace function public.cancel_review_funnel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reason text;
begin
  reason := case
    when NEW.status = 'cancelled' then 'booking_cancelled'
    else 'unchecked'
  end;

  update public.reviews
     set cancelled_at = timezone('utc', now()),
         cancel_reason = reason
   where booking_id = NEW.id
     and cancelled_at is null;

  -- Anything already queued for this booking must not go out.
  update public.scheduled_messages
     set status = 'canceled'
   where booking_id = NEW.id
     and status = 'pending'
     and tag in ('review_ask', 'review_reask', 'review_link', 'review_followup');

  return NEW;
end;
$$;

comment on function public.cancel_review_funnel() is
  'Stops the post-tour review funnel for a booking that was un-checked-in or cancelled. Port of Xano fn 94 deleting the flowList timers.';

drop trigger if exists cancel_review_funnel_on_booking_change on public.bookings;
create trigger cancel_review_funnel_on_booking_change
after update on public.bookings
for each row
when (
  (OLD.checked_in_at is not null and NEW.checked_in_at is null)
  or (OLD.status <> 'cancelled' and NEW.status = 'cancelled')
)
execute function public.cancel_review_funnel();
