-- Two more manager permissions, owner-set on /admin/staff/[id]:
--   can_manage_sales  refund a card or cash sale, void a cash sale, move a sale
--                     between kiosks (the payments function's money actions)
--   can_manage_team   change the team: add employees, change PINs, pause or
--                     remove them (the People tab)
-- Both default ON so nothing changes for today's managers; the owner turns them
-- off per person. Owners always have both. Check-in accounts never get either
-- (the payments function refuses them, and Team is not theirs).

alter table public.staff
  add column if not exists can_manage_sales boolean not null default true,
  add column if not exists can_manage_team  boolean not null default true;
comment on column public.staff.can_manage_sales is
  'Manager may refund, void and move sales (payments function). Owners always.';
comment on column public.staff.can_manage_team is
  'Manager may add, edit, pause and remove employees on Team. Owners always.';

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path to 'pg_catalog', 'public'
as $$
declare
  s      public.staff%rowtype;
  claims jsonb;
begin
  select * into s
  from public.staff
  where user_id = (event->>'user_id')::uuid
  limit 1;

  claims := event->'claims';

  if s.id is null then
    claims := jsonb_set(claims, '{app_staff}', 'null'::jsonb);
  else
    claims := jsonb_set(claims, '{app_staff}', jsonb_build_object(
      'id',                   s.id,
      'full_name',            s.full_name,
      'role',                 s.role,
      'business_id',          s.business_id,
      'is_active',            s.is_active,
      'kiosk_slug',           s.kiosk_slug,
      'can_create_bookings',  s.can_create_bookings,
      'can_edit_bookings',    s.can_edit_bookings,
      'can_check_in',         s.can_check_in,
      'can_void_bookings',    s.can_void_bookings,
      'can_add_to_peek',      s.can_add_to_peek,
      'can_view_attachments', s.can_view_attachments,
      'can_redeem_groupon',   s.can_redeem_groupon,
      'can_view_details',     s.can_view_details,
      'can_use_caja',         s.can_use_caja,
      'can_manage_sales',     s.can_manage_sales,
      'can_manage_team',      s.can_manage_team,
      'pin_required',         s.pin_required
    ));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Team changes: the employee pool's write policies now honour can_manage_team.
-- current_staff() carries no permissions, so the policy reads the caller's own
-- staff row (their select policy always allows their own row).
drop policy if exists kiosk_employees_insert on public.kiosk_employees;
drop policy if exists kiosk_employees_update on public.kiosk_employees;
drop policy if exists kiosk_employees_delete on public.kiosk_employees;

create policy kiosk_employees_insert on public.kiosk_employees
  for insert to authenticated
  with check (
    exists (
      select 1 from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner' or (cs.role = 'business_manager' and s.can_manage_team)
    )
  );

create policy kiosk_employees_update on public.kiosk_employees
  for update to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner' or (cs.role = 'business_manager' and s.can_manage_team)
    )
  )
  with check (
    exists (
      select 1 from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner' or (cs.role = 'business_manager' and s.can_manage_team)
    )
  );

create policy kiosk_employees_delete on public.kiosk_employees
  for delete to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner' or (cs.role = 'business_manager' and s.can_manage_team)
    )
  );
