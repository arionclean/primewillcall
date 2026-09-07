-- People and Accounts: one person may have a PIN, a website login, or both.
--
-- The Team screen no longer shows two lists of "people". A person is one card:
-- their PIN (a kiosk_employees row, for the tablets and shared computers) and,
-- for those who manage things, their own website login (a staff row). The link
-- between the two is kiosk_employees.staff_id. Shared desk logins (role check_in)
-- are not people; they are the Accounts tab.
--
-- activity_feed's person filter follows: a person is matched by either identity,
-- so someone with both a PIN and a login sees their tablet rows (employee) and
-- their own-laptop rows (staff) under one name.

alter table public.kiosk_employees
  add column if not exists staff_id uuid unique references public.staff(id) on delete set null;
comment on column public.kiosk_employees.staff_id is
  'The website login of the same person, when they have one. A PIN-only worker has none.';

create or replace function public.activity_feed(
  p_from timestamptz,
  p_to timestamptz,
  p_source text default null,
  p_employee uuid default null,
  p_staff uuid default null,
  p_kiosk text default null,
  p_events text[] default null,
  p_include_debug boolean default false,
  p_before_at timestamptz default null,
  p_before_key text default null,
  p_limit integer default 100
)
returns table (
  key text,
  source text,
  at timestamptz,
  event text,
  level text,
  ref text,
  payload jsonb,
  kiosk_slug text,
  employee_id uuid,
  employee_name text,
  actor_staff_id uuid,
  actor_name text,
  entity text,
  entity_id text,
  changed text[]
)
language sql
stable
security invoker
set search_path = public
as $$
  with rows as (
    select 'tablet:' || lpad(e.id::text, 14, '0') as key,
           'tablet'::text as source, e.at, e.event, e.level, e.ref, e.payload,
           e.kiosk_slug, e.employee_id, e.employee_name,
           null::uuid as actor_staff_id, null::text as actor_name,
           null::text as entity, null::text as entity_id, '{}'::text[] as changed
      from public.kiosk_events e
     where (p_source is null or p_source = 'tablet')
       and e.at >= p_from and e.at < p_to
       and ((p_employee is null and p_staff is null)
            or (p_employee is not null and e.employee_id = p_employee))
       and (p_kiosk is null or e.kiosk_slug = p_kiosk)
       and (p_events is null or e.event = any (p_events))
       and (p_include_debug or e.level <> 'debug')
    union all
    select 'web:' || lpad(a.id::text, 14, '0') as key,
           'web'::text as source, a.occurred_at as at,
           a.entity || '.' || a.action as event,
           case when a.action = 'wrong_pin' then 'warn' else 'info' end as level,
           coalesce(a.payload->>'ref', null) as ref, a.payload,
           null::text as kiosk_slug, a.employee_id, a.employee_name,
           a.actor_staff_id, s.full_name as actor_name,
           a.entity, a.entity_id, a.changed
      from public.audit_log a
      left join public.staff s on s.id = a.actor_staff_id
     where (p_source is null or p_source = 'web')
       and a.occurred_at >= p_from and a.occurred_at < p_to
       and p_kiosk is null
       and ((p_employee is null and p_staff is null)
            or (p_employee is not null and a.employee_id = p_employee)
            or (p_staff is not null and a.actor_staff_id = p_staff))
       and (p_events is null or (a.entity || '.' || a.action) = any (p_events))
  )
  select *
    from rows r
   where p_before_at is null
      or r.at < p_before_at
      or (r.at = p_before_at and r.key < coalesce(p_before_key, ''))
   order by r.at desc, r.key desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;
