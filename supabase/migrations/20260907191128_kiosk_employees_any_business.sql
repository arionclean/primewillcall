-- Kiosk employees: the PIN no longer mixes in a business.
--
-- People move between Prime's businesses, so the hash becomes sha256(salt:pin) and the
-- PIN is unique across every active employee, checked by kiosk_pin_in_use (a definer
-- function, so the check covers rows the caller's RLS would hide; it answers only yes
-- or no). Hashes stored before this are invalid and were set again from
-- /admin/employees (only the demo employee existed when this ran). kiosk_ids, the
-- per-tablet restriction, was never exposed and goes.
--
-- This migration also introduced a per-person business list (business_ids); the next
-- one (kiosk_employees_shared_pool) removed it minutes later when the owner asked for
-- no "works at" at all. It is kept here as it ran.

alter table public.kiosk_employees
  add column if not exists business_ids uuid[] not null default '{}';

update public.kiosk_employees
   set business_ids = array[business_id]
 where business_ids = '{}' and business_id is not null;

-- The old policies name business_id, so they go before the column does.
drop policy if exists kiosk_employees_select on public.kiosk_employees;
drop policy if exists kiosk_employees_insert on public.kiosk_employees;
drop policy if exists kiosk_employees_update on public.kiosk_employees;
drop policy if exists kiosk_employees_delete on public.kiosk_employees;

drop index if exists public.kiosk_employees_business_idx;
alter table public.kiosk_employees
  drop column if exists business_id,
  drop column if exists kiosk_ids;

comment on column public.kiosk_employees.business_ids is
  'Businesses whose tablets this person may unlock. Empty = every business.';
comment on column public.kiosk_employees.pin_hash is
  'sha256(salt:pin), lower-case hex. Unique among active employees platform-wide (kiosk_pin_in_use).';

create index if not exists kiosk_employees_business_ids_idx
  on public.kiosk_employees using gin (business_ids);

create policy kiosk_employees_select on public.kiosk_employees
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or ((cs.role = 'business_manager' or cs.role = 'check_in')
             and (kiosk_employees.business_ids = '{}'
                  or cs.business_id = any (kiosk_employees.business_ids)))
    )
  );

create policy kiosk_employees_insert on public.kiosk_employees
  for insert to authenticated
  with check (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager'
             and kiosk_employees.business_ids = array[cs.business_id])
    )
  );

create policy kiosk_employees_update on public.kiosk_employees
  for update to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager'
             and kiosk_employees.business_ids = array[cs.business_id])
    )
  )
  with check (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager'
             and kiosk_employees.business_ids = array[cs.business_id])
    )
  );

create policy kiosk_employees_delete on public.kiosk_employees
  for delete to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager'
             and kiosk_employees.business_ids = array[cs.business_id])
    )
  );

-- A PIN must be unique across every active employee, including ones the caller's RLS
-- would hide, so the check runs as definer. It answers only yes or no, never whose PIN
-- it is. Same hash as the app: sha256(salt || ':' || pin), hex.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.kiosk_pin_in_use(p_pin text, p_except uuid default null)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from public.kiosk_employees e
     where e.is_active
       and (p_except is null or e.id <> p_except)
       and e.pin_hash = encode(extensions.digest(e.pin_salt || ':' || p_pin, 'sha256'), 'hex')
  );
$$;

revoke all on function public.kiosk_pin_in_use(text, uuid) from public;
grant execute on function public.kiosk_pin_in_use(text, uuid) to authenticated;
