-- Activity for the web app, and an employee PIN on shared logins.
--
-- The tablets already record who did what (kiosk_events + the employee PIN). This
-- brings the web app to the same place with three pieces:
--
-- 1. audit_log gets written. Every table staff touch gets one generic trigger,
--    log_staff_change(), which records who (the staff account, and the employee
--    behind a shared login), what (table, row, created / updated / deleted, the
--    columns that changed with before and after) and where (business). It only
--    fires for a real staff session (auth.uid() set): the Xano sync, Stripe
--    webhooks and the kiosk functions run as the system and are not staff actions.
--    The employee rides in on an `x-employee-id` request header, which PostgREST
--    exposes to the trigger; the app sets it on every client once someone has
--    unlocked with their PIN.
-- 2. staff.pin_required marks a login as shared: the web asks for an employee PIN
--    before use, exactly like the tablet. Personal logins never see the keypad but
--    their actions are logged all the same, under the account.
-- 3. activity_feed() reads tablet and web rows as one stream with one set of
--    filters and keyset paging (replaces kiosk_activity, which was tablet-only).

-- ── Shared logins ─────────────────────────────────────────────────────────────

alter table public.staff
  add column if not exists pin_required boolean not null default false;
comment on column public.staff.pin_required is
  'A shared login (one computer, several people): the web asks for an employee PIN before use and stamps the employee on every action. Owner-set on /admin/staff/[id].';

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
      'can_delete_bookings',  s.can_delete_bookings,
      'can_add_to_peek',      s.can_add_to_peek,
      'can_view_attachments', s.can_view_attachments,
      'can_redeem_groupon',   s.can_redeem_groupon,
      'can_view_details',     s.can_view_details,
      'can_use_caja',         s.can_use_caja,
      'pin_required',         s.pin_required
    ));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ── audit_log: the shape the web activity needs ───────────────────────────────

alter table public.audit_log
  alter column entity_id type text using entity_id::text,
  add column if not exists business_id   uuid references public.businesses(id) on delete set null,
  add column if not exists employee_id   uuid references public.kiosk_employees(id) on delete set null,
  add column if not exists employee_name text,
  add column if not exists changed       text[] not null default '{}',
  add column if not exists source        text not null default 'web';

comment on table public.audit_log is
  'What staff did in the web app, one row per created / updated / deleted row on the tables staff touch, written by the log_staff_change trigger (plus explicit rows from the payments function and the employee PIN). actor_staff_id is the login, employee_id the person behind a shared login. Read on /admin/employees through activity_feed().';

create index if not exists audit_log_at_id_idx on public.audit_log (occurred_at desc, id desc);
create index if not exists audit_log_actor_at_idx on public.audit_log (actor_staff_id, occurred_at desc);
create index if not exists audit_log_employee_at_idx on public.audit_log (employee_id, occurred_at desc)
  where employee_id is not null;
create index if not exists audit_log_business_at_idx on public.audit_log (business_id, occurred_at desc);

-- Live feed on the Employees page.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'audit_log'
  ) then
    alter publication supabase_realtime add table public.audit_log;
  end if;
end $$;

-- Read: owner everything; a manager their business's rows and their own; check-in
-- their own. Nobody writes directly: the trigger and the definer functions do.
drop policy if exists audit_log_select on public.audit_log;
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or cs.staff_id = audit_log.actor_staff_id
         or (cs.role = 'business_manager' and cs.business_id = audit_log.business_id)
    )
  );

-- ── The trigger ───────────────────────────────────────────────────────────────

/** The employee behind this request, if the app sent one and it checks out. */
create or replace function public.request_employee()
returns table (id uuid, name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw text;
begin
  begin
    raw := current_setting('request.headers', true)::json->>'x-employee-id';
  exception when others then
    raw := null;
  end;
  if raw is null or raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return;
  end if;
  return query
    select e.id, e.name from public.kiosk_employees e
     where e.id = raw::uuid and e.is_active;
end;
$$;

create or replace function public.log_staff_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Columns that change on their own and say nothing about what a person did.
  noise   constant text[] := array['updated_at', 'last_seen_at', 'last_seen_kiosk', 'synced_at',
                                   'xano_synced_at', 'legacy_synced_at', 'search_vector'];
  -- Columns whose values never belong in a log (their names still do).
  secret  constant text[] := array['pin_hash', 'pin_salt', 'raw', 'public_token', 'password'];
  actor   uuid;
  biz     uuid;
  rowj    jsonb;
  oldj    jsonb;
  diff    jsonb := '{}'::jsonb;
  cols    text[] := '{}';
  k       text;
  emp_id  uuid;
  emp_nm  text;
  act     text;
  ref     text;
  extra   jsonb := '{}'::jsonb;
begin
  -- Only a person's own session is a staff action. System writes (the Xano sync,
  -- webhooks, the kiosk functions, cron) carry no auth.uid() and are not logged.
  if auth.uid() is null then
    return null;
  end if;
  select cs.staff_id, cs.business_id into actor, biz from public.current_staff() cs;
  if actor is null then
    return null;
  end if;

  if tg_op = 'DELETE' then
    oldj := to_jsonb(old);
    act := 'deleted';
  elsif tg_op = 'INSERT' then
    rowj := to_jsonb(new);
    act := 'created';
  else
    rowj := to_jsonb(new);
    oldj := to_jsonb(old);
    act := 'updated';
    for k in select key from jsonb_each(rowj) loop
      if k = any (noise) then continue; end if;
      if rowj->k is distinct from oldj->k then
        cols := cols || k;
        if not (k = any (secret)) then
          diff := diff || jsonb_build_object(k, jsonb_build_array(oldj->k, rowj->k));
        end if;
      end if;
    end loop;
    -- A write that changed nothing worth a line (updated_at alone) is not logged.
    if cols = '{}' then
      return null;
    end if;
  end if;

  -- Where it happened: the row's business when it has one, else the actor's.
  biz := coalesce(
    nullif(coalesce(rowj->>'business_id', oldj->>'business_id'), '')::uuid,
    biz
  );

  -- The code staff know a booking or sale by, so the page can show it.
  ref := coalesce(rowj->>'legacy_id', oldj->>'legacy_id',
                  rowj->>'booking_ref', oldj->>'booking_ref',
                  rowj->>'ref', oldj->>'ref');

  -- A little context for the rows that need it: the guest's name on a booking.
  if tg_table_name = 'bookings' then
    select jsonb_build_object('guest', c.full_name) into extra
      from public.customers c
     where c.id = nullif(coalesce(rowj->>'customer_id', oldj->>'customer_id'), '')::uuid;
    extra := coalesce(extra, '{}'::jsonb);
  end if;

  select re.id, re.name into emp_id, emp_nm from public.request_employee() re limit 1;

  insert into public.audit_log (
    actor_staff_id, business_id, employee_id, employee_name,
    entity, entity_id, action, changed, payload, source
  ) values (
    actor, biz, emp_id, emp_nm,
    tg_table_name,
    coalesce(rowj->>'id', oldj->>'id'),
    act,
    cols,
    case
      when act = 'updated' then jsonb_build_object('diff', diff, 'ref', ref) || extra
      when act = 'created' then jsonb_build_object('row', rowj - secret, 'ref', ref) || extra
      else jsonb_build_object('row', oldj - secret, 'ref', ref) || extra
    end,
    'web'
  );
  return null;
end;
$$;

-- Attach to everything staff edit from the web. Each is AFTER + FOR EACH ROW, so
-- the write itself is never affected by the log.
do $$
declare
  t text;
begin
  foreach t in array array[
    'bookings', 'customers', 'cash_sales', 'stripe_refunds', 'tour_slot_closures',
    'tours', 'business_tours', 'tour_pax_tiers', 'businesses', 'staff', 'staff_tours',
    'kiosk_employees', 'messaging_rules', 'messaging_settings', 'kiosks'
  ] loop
    execute format('drop trigger if exists trg_log_staff_change on public.%I', t);
    execute format(
      'create trigger trg_log_staff_change after insert or update or delete on public.%I for each row execute function public.log_staff_change()',
      t
    );
  end loop;
end $$;

-- ── Employee PIN on the web ───────────────────────────────────────────────────

/**
 * The employee a PIN belongs to, for the web keypad. Definer, so the check does
 * not depend on what the caller may read; refused outside a staff session.
 * Records the attempt in audit_log either way.
 */
create or replace function public.web_employee_unlock(p_pin text)
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor  uuid;
  biz    uuid;
  m_id   uuid;
  m_name text;
begin
  select cs.staff_id, cs.business_id into actor, biz from public.current_staff() cs;
  if actor is null then
    return;
  end if;
  if p_pin !~ '^\d{4}$' then
    return;
  end if;
  select e.id, e.name into m_id, m_name
    from public.kiosk_employees e
   where e.is_active
     and e.pin_hash = encode(extensions.digest(e.pin_salt || ':' || p_pin, 'sha256'), 'hex')
   limit 1;
  if m_id is null then
    insert into public.audit_log (actor_staff_id, business_id, entity, action, source)
    values (actor, biz, 'employee', 'wrong_pin', 'web');
    return;
  end if;
  update public.kiosk_employees
     set last_seen_at = now(), last_seen_kiosk = 'web'
   where kiosk_employees.id = m_id;
  insert into public.audit_log (actor_staff_id, business_id, employee_id, employee_name, entity, entity_id, action, source)
  values (actor, biz, m_id, m_name, 'employee', m_id::text, 'signed_in', 'web');
  return query select m_id, m_name;
end;
$$;

/** The person tapped Lock on the web. */
create or replace function public.web_employee_lock(p_employee uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
  biz   uuid;
  nm    text;
begin
  select cs.staff_id, cs.business_id into actor, biz from public.current_staff() cs;
  if actor is null then
    return;
  end if;
  select e.name into nm from public.kiosk_employees e where e.id = p_employee;
  insert into public.audit_log (actor_staff_id, business_id, employee_id, employee_name, entity, entity_id, action, source)
  values (actor, biz, p_employee, nm, 'employee', p_employee::text, 'signed_out', 'web');
end;
$$;

revoke all on function public.web_employee_unlock(text) from public;
revoke all on function public.web_employee_lock(uuid) from public;
grant execute on function public.web_employee_unlock(text) to authenticated;
grant execute on function public.web_employee_lock(uuid) to authenticated;

-- ── One feed for tablets and web ──────────────────────────────────────────────

drop function if exists public.kiosk_activity(timestamptz, timestamptz, uuid, text, text[], boolean, boolean, text, timestamptz, bigint, integer);
drop function if exists public.kiosk_activity_count(timestamptz, timestamptz, uuid, text, text[], boolean, boolean, text);

-- Tablet rows keep their event names (pin_ok, check_in, ...); web rows are
-- named entity.action (bookings.updated, stripe_refunds.created, employee.signed_in)
-- and carry `changed` + the diff in payload, so the page can say what actually
-- happened. `key` is the keyset cursor across both sources.
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
       and p_staff is null
       and (p_employee is null or e.employee_id = p_employee)
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
       and (p_employee is null or a.employee_id = p_employee)
       and (p_staff is null or a.actor_staff_id = p_staff)
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

grant execute on function public.activity_feed(timestamptz, timestamptz, text, uuid, uuid, text, text[], boolean, timestamptz, text, integer) to authenticated;
