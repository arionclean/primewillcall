-- Why a booking vanished from a staff screen and came back.
--
-- Staff report reservations disappearing and reappearing. The suspected cause is the
-- Xano sync, which rewrites a booking in place ~30 times an hour and overwrites
-- business_tour_id, starts_at, status, checked_in_at and total_cents on every write.
-- If one of those lands wrong the row drops out of the filtered list, and the next
-- sync puts it back. Nothing could confirm that, because an UPDATE overwrites the old
-- value and it is gone.
--
-- This records only the fields that actually changed, only for the columns that can
-- move a booking on screen. An untouched column costs nothing.

create table if not exists public.booking_changes (
  id bigserial primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  changed_at timestamptz not null default now(),
  -- Postgres role behind the write. The Xano sync and the webhooks run as the service
  -- role, staff run as authenticated, so this separates "the sync did it" from
  -- "someone did it in the app" without threading an app-level actor through.
  changed_by text not null default current_user,
  changes jsonb not null
);

create index if not exists booking_changes_booking_idx
  on public.booking_changes (booking_id, changed_at desc);
create index if not exists booking_changes_at_idx
  on public.booking_changes (changed_at desc);

comment on table public.booking_changes is
  'Field-level history of the booking columns that decide whether a booking appears on '
  'a staff screen. Written by trg_log_booking_changes. Read it when a booking is '
  'reported as disappearing.';

create or replace function public.log_booking_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  diff jsonb := '{}'::jsonb;
begin
  -- Only the columns that move a booking on screen. starts_at moves it between days,
  -- business_tour_id between products, status and awaiting_payment hide it outright,
  -- checked_in_at moves it between the manifest's two halves.
  if new.business_tour_id is distinct from old.business_tour_id then
    diff := diff || jsonb_build_object('business_tour_id',
      jsonb_build_array(old.business_tour_id, new.business_tour_id));
  end if;
  if new.business_id is distinct from old.business_id then
    diff := diff || jsonb_build_object('business_id',
      jsonb_build_array(old.business_id, new.business_id));
  end if;
  if new.starts_at is distinct from old.starts_at then
    diff := diff || jsonb_build_object('starts_at',
      jsonb_build_array(old.starts_at, new.starts_at));
  end if;
  if new.status is distinct from old.status then
    diff := diff || jsonb_build_object('status',
      jsonb_build_array(old.status, new.status));
  end if;
  if new.awaiting_payment is distinct from old.awaiting_payment then
    diff := diff || jsonb_build_object('awaiting_payment',
      jsonb_build_array(old.awaiting_payment, new.awaiting_payment));
  end if;
  if new.checked_in_at is distinct from old.checked_in_at then
    diff := diff || jsonb_build_object('checked_in_at',
      jsonb_build_array(old.checked_in_at, new.checked_in_at));
  end if;
  if new.customer_id is distinct from old.customer_id then
    diff := diff || jsonb_build_object('customer_id',
      jsonb_build_array(old.customer_id, new.customer_id));
  end if;
  if new.total_cents is distinct from old.total_cents then
    diff := diff || jsonb_build_object('total_cents',
      jsonb_build_array(old.total_cents, new.total_cents));
  end if;

  -- A write that touched none of them is the common case (a note, a pax edit). Logging
  -- it would bury the rows that matter under noise.
  if diff = '{}'::jsonb then
    return new;
  end if;

  insert into public.booking_changes (booking_id, changes)
  values (new.id, diff);

  return new;
end;
$$;

drop trigger if exists trg_log_booking_changes on public.bookings;

create trigger trg_log_booking_changes
after update on public.bookings
for each row
execute function public.log_booking_changes();

-- Owner-only. This is a diagnostic surface, not something staff act on, and it carries
-- the movements of every business's bookings.
alter table public.booking_changes enable row level security;

drop policy if exists booking_changes_select on public.booking_changes;
create policy booking_changes_select on public.booking_changes
for select
using (
  exists (
    select 1 from current_staff() cs(staff_id, role, business_id)
    where cs.role = 'owner'::staff_role
  )
);
