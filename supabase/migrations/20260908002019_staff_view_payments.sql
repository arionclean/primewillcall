-- A third manager switch: can_view_payments. Off, the Payments page is hidden
-- from that manager (sidebar link gone, page redirects). Screen-level, like
-- can_view_details: the totals RPCs stay RLS-scoped by business regardless.
-- Defaults ON so nothing changes for today's managers.

alter table public.staff
  add column if not exists can_view_payments boolean not null default true;
comment on column public.staff.can_view_payments is
  'Manager may open the Payments page. Owners always. Screen-level.';

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
      'can_view_payments',    s.can_view_payments,
      'pin_required',         s.pin_required
    ));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;
