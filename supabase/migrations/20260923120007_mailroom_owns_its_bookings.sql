-- Mailroom: the OTA bookings it creates are ours to text.
--
-- Until 2026-09-23 every OTA reservation email also reached Xano (the Make scenario
-- posted it there), and Xano's own trigger sent the guest the confirmation text and,
-- after the tour, the review ask. Our automations stayed out of it on purpose: they
-- only ever touch bookings born here (legacy_id IS NULL), and the Mailroom writes
-- through xano-booking-sync, which keys every OTA booking as `ota-<reference>`. With
-- Make switched off, Xano never hears of these bookings, so nobody texted the guest.
--
-- The booking key cannot simply become NULL: `ota-<reference>` is what makes a resent
-- or amended OTA email land on the one booking instead of a second one. So the
-- Mailroom marks the booking it CREATES with the email it came from, and that mark is
-- what makes it ours:
--
--   * trg_native_booking_automations fires for it (the confirmation texts), but only
--     when it is inserted confirmed and for a departure still ahead. A cancellation
--     email for a booking we never had, or an email that arrives after the tour,
--     texts nobody.
--   * enqueue-review-asks takes it (the review funnel).
--
-- Only an insert sets it. An email that updates a booking created earlier leaves the
-- mark as it was, so a booking Xano already texted (everything from before the
-- switch) is never texted a second time.

set local lock_timeout = '5s';

alter table public.bookings
  add column if not exists inbound_email_id uuid;

comment on column public.bookings.inbound_email_id is
  'The Mailroom email (inbound_emails) this booking was created from. Set on insert by '
  'xano-booking-sync when the Mailroom calls it, never on update. Marks an OTA booking '
  'as ours for guest messaging: confirmation texts and the review funnel.';

-- NOT VALID then VALIDATE, so the only lock that blocks the bookings table is the
-- instant one of adding the constraint, not a scan under it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_inbound_email_id_fkey'
  ) then
    alter table public.bookings
      add constraint bookings_inbound_email_id_fkey
      foreign key (inbound_email_id) references public.inbound_emails(id)
      on delete set null not valid;
  end if;
end $$;

alter table public.bookings validate constraint bookings_inbound_email_id_fkey;

create index if not exists bookings_inbound_email_idx
  on public.bookings (inbound_email_id)
  where inbound_email_id is not null;

drop trigger if exists trg_native_booking_automations on public.bookings;
create trigger trg_native_booking_automations
  after insert on public.bookings
  for each row
  when (
    (new.legacy_id is null and new.status <> 'pending'::booking_status)
    or (
      new.inbound_email_id is not null
      and new.status = 'confirmed'::booking_status
      and new.starts_at > now()
    )
  )
  execute function public.on_native_booking_created();
