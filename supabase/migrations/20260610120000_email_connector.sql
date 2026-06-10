-- OTA email connector schema (Supabase port of the Xano email-connector).
--
-- Objects backing supabase/functions/email-booking-parse: a normalized-name ->
-- tour alias table the deterministic matcher reads, an RPC that resolves an OTA
-- product to a tour + operator, a review queue for the cases it cannot place,
-- and the RPCs the owner's "Unrecognized bookings" page uses to resolve them.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE). Assumes the legacy_* columns
-- (tours.legacy_name_variations, business_tours.legacy_product_id,
-- businesses.legacy_company_id) already exist. The alias rows are seeded
-- separately from Xano (data, not schema).

-- Shared normalizer: lowercase + strip everything but [a-z0-9]. Mirrors the
-- JS norm() used in the edge functions.
create or replace function public.app_norm(s text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select lower(regexp_replace(coalesce(s, ''), '[^a-zA-Z0-9]+', '', 'g'))
$$;

-- ── Alias table: normalized OTA product title -> master tour ───────────────────
create table if not exists public.tour_name_aliases (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references public.tours(id) on delete cascade,
  normalized_name text not null,
  raw_name text,
  source text not null default 'manual' check (source in ('xano_seed', 'ai', 'manual')),
  created_at timestamptz not null default now()
);
create unique index if not exists tour_name_aliases_norm_key
  on public.tour_name_aliases (normalized_name);
create index if not exists tour_name_aliases_tour_idx
  on public.tour_name_aliases (tour_id);

alter table public.tour_name_aliases enable row level security;
revoke all on table public.tour_name_aliases from anon;
drop policy if exists tour_name_aliases_select on public.tour_name_aliases;
create policy tour_name_aliases_select on public.tour_name_aliases
  for select to authenticated
  using (exists (select 1 from public.current_staff()));

-- ── Review queue for emails the matcher could not place ────────────────────────
create table if not exists public.email_match_queue (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'urgent'
    check (status in ('verify', 'urgent', 'resolved', 'ignored')),
  reason text not null
    check (reason in ('ai_classified', 'no_match', 'needs_assignment')),
  original_product_name text,
  supplier text,
  booking_channel text,
  legacy_company_id text,
  business_id uuid references public.businesses(id) on delete set null,
  suggested_tour_id uuid references public.tours(id) on delete set null,
  ai_confidence text,
  parsed jsonb,
  resolved_tour_id uuid references public.tours(id) on delete set null,
  resolved_by_staff_id uuid references public.staff(id) on delete set null,
  resolved_at timestamptz
);
create index if not exists email_match_queue_status_idx
  on public.email_match_queue (status, created_at desc);
create index if not exists email_match_queue_business_idx
  on public.email_match_queue (business_id);

alter table public.email_match_queue enable row level security;
revoke all on table public.email_match_queue from anon;
-- Service role (edge function) inserts, bypassing RLS, so there is no insert policy.
drop policy if exists email_match_queue_select on public.email_match_queue;
create policy email_match_queue_select on public.email_match_queue
  for select to authenticated
  using (exists (
    select 1 from public.current_staff() cs
    where cs.role = 'owner'::public.staff_role
       or (email_match_queue.business_id is not null and cs.business_id = email_match_queue.business_id)
  ));
drop policy if exists email_match_queue_update on public.email_match_queue;
create policy email_match_queue_update on public.email_match_queue
  for update to authenticated
  using (exists (
    select 1 from public.current_staff() cs
    where cs.role = 'owner'::public.staff_role
       or (email_match_queue.business_id is not null and cs.business_id = email_match_queue.business_id)
  ))
  with check (true);
drop policy if exists email_match_queue_delete on public.email_match_queue;
create policy email_match_queue_delete on public.email_match_queue
  for delete to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'::public.staff_role));

-- ── Deterministic OTA-product -> tour + operator resolver ──────────────────────
-- Product name (then supplier, then channel) -> master tour via the alias table;
-- the email's company -> operator business; business_tour = (operator, tour). If
-- the operator is not assigned the tour, business_tour_id is null (a signal the
-- edge function turns into a 'needs_assignment' queue row).
create or replace function public.match_ota_tour(
  p_product text,
  p_supplier text,
  p_channel text,
  p_company text
)
returns table (
  tour_id uuid,
  tour_name text,
  business_id uuid,
  business_tour_id uuid,
  method text
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with hit as (
    select a.tour_id,
      case
        when a.normalized_name = public.app_norm(p_product) then 'product'
        when a.normalized_name = public.app_norm(p_supplier) then 'supplier'
        else 'channel'
      end as method,
      case
        when a.normalized_name = public.app_norm(p_product) then 0
        when a.normalized_name = public.app_norm(p_supplier) then 1
        else 2
      end as pri
    from public.tour_name_aliases a
    where a.normalized_name = public.app_norm(p_product)
       or (p_supplier is not null and a.normalized_name = public.app_norm(p_supplier))
       or (p_channel is not null and a.normalized_name = public.app_norm(p_channel))
    order by pri
    limit 1
  ),
  biz as (
    select id from public.businesses where legacy_company_id = p_company limit 1
  )
  select h.tour_id, t.name, b.id, bt.id, h.method
  from hit h
  join public.tours t on t.id = h.tour_id
  left join biz b on true
  left join public.business_tours bt
    on bt.tour_id = h.tour_id and bt.business_id = b.id;
$$;
grant execute on function public.match_ota_tour(text, text, text, text) to authenticated;

-- ── Owner resolution: learn the alias + assign the tour + mark resolved ────────
create or replace function public.resolve_email_match(p_queue_id uuid, p_tour_id uuid)
returns public.email_match_queue
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  q public.email_match_queue;
  cs record;
  v_bt_id uuid;
  v_src_bt uuid;
begin
  select * into q from public.email_match_queue where id = p_queue_id;
  if not found then raise exception 'queue row not found'; end if;

  select staff_id, role, business_id into cs from public.current_staff() limit 1;
  if cs.staff_id is null then raise exception 'not authenticated'; end if;
  if cs.role is distinct from 'owner'::public.staff_role
     and not (cs.business_id is not null and cs.business_id = q.business_id) then
    raise exception 'not permitted for this business';
  end if;

  if q.original_product_name is not null and btrim(q.original_product_name) <> '' then
    insert into public.tour_name_aliases (tour_id, normalized_name, raw_name, source)
    values (p_tour_id, public.app_norm(q.original_product_name), q.original_product_name, 'manual')
    on conflict (normalized_name) do nothing;
  end if;

  if q.business_id is not null then
    select id into v_bt_id from public.business_tours
      where business_id = q.business_id and tour_id = p_tour_id limit 1;
    if v_bt_id is null then
      insert into public.business_tours (business_id, tour_id, name, is_active)
      select q.business_id, p_tour_id, t.name, true
      from public.tours t where t.id = p_tour_id
      returning id into v_bt_id;
      select bt.id into v_src_bt from public.business_tours bt
        where bt.tour_id = p_tour_id and bt.id <> v_bt_id
        order by bt.created_at limit 1;
      if v_src_bt is not null then
        insert into public.tour_pax_tiers
          (business_tour_id, label, description, price_cents, currency, sort_order, is_active)
        select v_bt_id, t.label, t.description, t.price_cents, t.currency, t.sort_order, t.is_active
        from public.tour_pax_tiers t where t.business_tour_id = v_src_bt;
      end if;
    end if;
  end if;

  update public.email_match_queue
    set status = 'resolved', resolved_tour_id = p_tour_id,
        resolved_by_staff_id = cs.staff_id, resolved_at = now()
    where id = p_queue_id
    returning * into q;
  return q;
end;
$$;

create or replace function public.ignore_email_match(p_queue_id uuid)
returns public.email_match_queue
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare q public.email_match_queue; cs record;
begin
  select * into q from public.email_match_queue where id = p_queue_id;
  if not found then raise exception 'queue row not found'; end if;
  select staff_id, role, business_id into cs from public.current_staff() limit 1;
  if cs.staff_id is null then raise exception 'not authenticated'; end if;
  if cs.role is distinct from 'owner'::public.staff_role
     and not (cs.business_id is not null and cs.business_id = q.business_id) then
    raise exception 'not permitted for this business';
  end if;
  update public.email_match_queue
    set status = 'ignored', resolved_by_staff_id = cs.staff_id, resolved_at = now()
    where id = p_queue_id returning * into q;
  return q;
end;
$$;

grant execute on function public.resolve_email_match(uuid, uuid) to authenticated;
grant execute on function public.ignore_email_match(uuid) to authenticated;
