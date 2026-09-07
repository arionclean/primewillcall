-- Kiosk employees with a 4-digit PIN, so every tablet action is attributed to a person.
--
-- The tablet login (kiosks.slug) identifies the iPad; it never said WHO was using it.
-- kiosk_employees adds the people: a name, a PIN (stored as a salted SHA-256, never in
-- clear), the business they belong to, and an active flag. The tablet asks
-- kiosk-pin-verify for the PIN, keeps the person unlocked until idle for
-- kiosks.pin_idle_lock_seconds, and sends the employee on every write and event.
-- The switch is kiosks.pin_required (default false): nothing changes on any tablet
-- until the owner turns it on for that kiosk. Owners and business managers manage the
-- people on /admin/employees and read the activity there (kiosk_events).

create table if not exists public.kiosk_employees (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id),
  name            text not null,
  pin_hash        text not null,               -- sha256(salt:business_id:pin), hex
  pin_salt        text not null,
  kiosk_ids       uuid[],                      -- null = every kiosk of the business
  is_active       boolean not null default true,
  last_seen_at    timestamptz,
  last_seen_kiosk text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.kiosk_employees is
  'People who use the PrimeKiosk tablets, identified by a 4-digit PIN (hashed). Managed on /admin/employees; verified by the kiosk-pin-verify function; referenced by kiosk_events, kiosk_sales, cash_sales and bookings.kiosk_employee_id.';

create index if not exists kiosk_employees_business_idx on public.kiosk_employees (business_id, is_active);

drop trigger if exists kiosk_employees_set_updated_at on public.kiosk_employees;
create trigger kiosk_employees_set_updated_at before update on public.kiosk_employees
  for each row execute function public.set_updated_at();

alter table public.kiosk_employees enable row level security;

drop policy if exists kiosk_employees_select on public.kiosk_employees;
create policy kiosk_employees_select on public.kiosk_employees
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or ((cs.role = 'business_manager' or cs.role = 'check_in') and cs.business_id = kiosk_employees.business_id)
    )
  );

drop policy if exists kiosk_employees_insert on public.kiosk_employees;
create policy kiosk_employees_insert on public.kiosk_employees
  for insert to authenticated
  with check (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = kiosk_employees.business_id)
    )
  );

drop policy if exists kiosk_employees_update on public.kiosk_employees;
create policy kiosk_employees_update on public.kiosk_employees
  for update to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = kiosk_employees.business_id)
    )
  )
  with check (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = kiosk_employees.business_id)
    )
  );

drop policy if exists kiosk_employees_delete on public.kiosk_employees;
create policy kiosk_employees_delete on public.kiosk_employees
  for delete to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = kiosk_employees.business_id)
    )
  );

-- The switch and the idle lock, per kiosk.
alter table public.kiosks
  add column if not exists pin_required boolean not null default false,
  add column if not exists pin_idle_lock_seconds integer not null default 120;
comment on column public.kiosks.pin_required is
  'When true a tablet on a build that supports it asks for an employee PIN before use and locks after pin_idle_lock_seconds idle. Old builds ignore it.';

-- Attribution columns. All nullable: rows from old builds simply carry no employee.
alter table public.kiosk_events
  add column if not exists employee_id uuid references public.kiosk_employees(id) on delete set null,
  add column if not exists employee_name text;
create index if not exists kiosk_events_employee_at_idx on public.kiosk_events (employee_id, at desc) where employee_id is not null;

alter table public.kiosk_sales
  add column if not exists employee_id uuid references public.kiosk_employees(id) on delete set null;

alter table public.cash_sales
  add column if not exists employee_id uuid references public.kiosk_employees(id) on delete set null;
comment on column public.cash_sales.employee_id is 'The kiosk employee (PIN) who recorded the sale on the tablet; null for sales from builds without PIN support.';

alter table public.bookings
  add column if not exists kiosk_employee_id uuid references public.kiosk_employees(id) on delete set null;
comment on column public.bookings.kiosk_employee_id is 'The kiosk employee (PIN) who created the booking on a tablet; null otherwise.';
