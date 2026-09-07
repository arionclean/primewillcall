-- Kiosk employees are one shared pool: anyone may use any tablet.
--
-- The businesses sit next to each other and people cover for each other, so the
-- owner asked for no "works at" at all. business_ids (added minutes earlier) goes,
-- and with it the per-business scoping: every active staff account reads the pool,
-- the owner and any business manager manage it. The PIN stays unique across the
-- pool (kiosk_pin_in_use) and identifies the person on every tablet.

drop policy if exists kiosk_employees_select on public.kiosk_employees;
drop policy if exists kiosk_employees_insert on public.kiosk_employees;
drop policy if exists kiosk_employees_update on public.kiosk_employees;
drop policy if exists kiosk_employees_delete on public.kiosk_employees;

drop index if exists public.kiosk_employees_business_ids_idx;
alter table public.kiosk_employees drop column if exists business_ids;

comment on table public.kiosk_employees is
  'People who use the PrimeKiosk tablets, one pool shared by every business, identified by a 4-digit PIN (hashed). Managed on /admin/employees; verified by the kiosk-pin-verify function; referenced by kiosk_events, kiosk_sales, cash_sales and bookings.kiosk_employee_id.';

create policy kiosk_employees_select on public.kiosk_employees
  for select to authenticated
  using (exists (select 1 from public.current_staff()));

create policy kiosk_employees_insert on public.kiosk_employees
  for insert to authenticated
  with check (
    exists (
      select 1 from public.current_staff() cs
      where cs.role in ('owner', 'business_manager')
    )
  );

create policy kiosk_employees_update on public.kiosk_employees
  for update to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role in ('owner', 'business_manager')
    )
  )
  with check (
    exists (
      select 1 from public.current_staff() cs
      where cs.role in ('owner', 'business_manager')
    )
  );

create policy kiosk_employees_delete on public.kiosk_employees
  for delete to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role in ('owner', 'business_manager')
    )
  );
