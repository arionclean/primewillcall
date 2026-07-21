-- Kiosk capabilities + modern read scope.
--
-- 1. kiosks.can_create_bookings: mirrors the staff capability of the same
--    name. Selling tablets keep it true; reader tablets (check-in / scan
--    only) get false. The /admin/payments Source filter lists only kiosks
--    that can create bookings, since readers never produce sales.
--
-- 2. kiosks_select still scoped managers through kiosk_tours, which is
--    legacy and empty, so only the owner could read kiosks at all. Rescope
--    by kiosks.business_id (added with the Kiosk POS work) like every other
--    business-owned table: owner sees all, business_manager and check_in see
--    their own business's kiosks.

alter table public.kiosks
  add column if not exists can_create_bookings boolean not null default true;

comment on column public.kiosks.can_create_bookings is
  'Selling tablets true; reader tablets (check-in only) false. Filters them out of the payments Source filter.';

drop policy if exists kiosks_select on public.kiosks;
create policy kiosks_select on public.kiosks
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or cs.business_id = kiosks.business_id
    )
  );
