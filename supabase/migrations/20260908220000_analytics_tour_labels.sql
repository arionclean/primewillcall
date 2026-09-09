-- Product names for /analytics only.
--
-- The master tour "Miami Skyline Cruises" is named after the business that sells
-- it and after the website that books it, so on /analytics the Products column
-- and the Sources column read the same words and nobody could tell them apart.
-- The owner wants the product called "Boat Tour" there, and ONLY there: the
-- bookings list, the schedule dropdown and the guest's booking page keep the
-- name guests actually booked.
--
-- So this is the tours twin of booking_source_labels: the real name is never
-- rewritten, a lookup decides what analytics shows. That also leaves the Xano
-- sync alone, which resolves a tour by business_tours.name.
--
-- A tour with no row here shows its own name, exactly as before.

create table if not exists public.tour_analytics_labels (
  tour_id    uuid primary key references public.tours(id) on delete cascade,
  label      text not null,
  updated_at timestamptz not null default now()
);

comment on table public.tour_analytics_labels is
  'Display name per tour, for /analytics only. Owner-edited. tours.name is never rewritten.';

alter table public.tour_analytics_labels enable row level security;

drop policy if exists tour_analytics_labels_select on public.tour_analytics_labels;
create policy tour_analytics_labels_select on public.tour_analytics_labels
  for select to authenticated
  using (exists (select 1 from public.current_staff()));

drop policy if exists tour_analytics_labels_owner_write on public.tour_analytics_labels;
create policy tour_analytics_labels_owner_write on public.tour_analytics_labels
  for all to authenticated
  using      (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- The one label asked for on 2026-09-08. Selected by name so no generated id is
-- baked into the migration.
insert into public.tour_analytics_labels (tour_id, label)
select id, 'Boat Tour' from public.tours where name = 'Miami Skyline Cruises'
on conflict (tour_id) do update
  set label = excluded.label, updated_at = now();

-- PostgREST computed column: select "analytics_label" on tours. Lets the page's
-- own product chips read the same name the RPCs below return.
create or replace function public.analytics_label(public.tours)
returns text
language sql
stable
set search_path to 'public'
as $$
  select coalesce(
    (select l.label from tour_analytics_labels l where l.tour_id = $1.id),
    $1.name
  )
$$;

comment on function public.analytics_label(public.tours) is
  'PostgREST computed column: select "analytics_label" on tours for its /analytics display name.';

grant execute on function public.analytics_label(public.tours) to authenticated;

-- ── the three analytics RPCs ─────────────────────────────────────────────────
-- Same bodies as before; the only change is the tour expression, which now
-- prefers the label. Still SECURITY INVOKER so RLS scopes the caller.

create or replace function public.analytics_source_tour(
  p_start timestamptz,
  p_end   timestamptz
)
returns table (
  source      text,
  tour        text,
  color       text,
  business_id uuid,
  business    text,
  pax         bigint,
  bookings    bigint
)
language sql
stable
set search_path to 'public'
as $$
  select
    coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct') as source,
    coalesce(tl.label, t.name, bt.name, 'Unknown')                   as tour,
    t.color                                                           as color,
    biz.id                                                            as business_id,
    biz.name                                                          as business,
    sum(b.pax_adult + b.pax_child + b.pax_infant)::bigint             as pax,
    count(*)::bigint                                                  as bookings
  from bookings b
  join business_tours bt on bt.id = b.business_tour_id
  join businesses biz on biz.id = b.business_id
  left join tours t on t.id = bt.tour_id
  left join tour_analytics_labels tl on tl.tour_id = t.id
  left join booking_source_labels l
         on lower(l.channel) = lower(btrim(b.source_channel))
  where b.starts_at >= p_start
    and b.starts_at <  p_end
    and b.status <> 'cancelled'
  group by 1, 2, 3, 4, 5
$$;

create or replace function public.analytics_daily_by_tour(
  p_start timestamptz,
  p_end   timestamptz,
  p_tz    text
)
returns table (
  day              integer,
  business_tour_id uuid,
  tour             text,
  color            text,
  pax              bigint,
  bookings         bigint
)
language sql
stable
set search_path to 'public'
as $$
  select
    extract(day from (b.starts_at at time zone p_tz))::int   as day,
    b.business_tour_id,
    coalesce(tl.label, t.name, bt.name, 'Unknown')           as tour,
    t.color                                                  as color,
    sum(b.pax_adult + b.pax_child + b.pax_infant)::bigint    as pax,
    count(*)::bigint                                         as bookings
  from bookings b
  join business_tours bt on bt.id = b.business_tour_id
  left join tours t on t.id = bt.tour_id
  left join tour_analytics_labels tl on tl.tour_id = t.id
  where b.starts_at >= p_start
    and b.starts_at <  p_end
    and b.status <> 'cancelled'
  group by 1, 2, 3, 4
$$;

create or replace function public.analytics_bookings(
  p_start       timestamptz,
  p_end         timestamptz,
  p_source      text default null,
  p_tour        text default null,
  p_business_id uuid default null
)
returns table (
  id         uuid,
  starts_at  timestamptz,
  customer   text,
  pax        integer,
  status     text,
  created_at timestamptz,
  source     text,
  tour       text,
  business   text
)
language sql
stable
set search_path to 'public'
as $$
  with rows as (
    select
      b.id,
      b.starts_at,
      coalesce(nullif(btrim(c.full_name), ''), 'Guest')                as customer,
      (b.pax_adult + b.pax_child + b.pax_infant)                        as pax,
      b.status::text                                                    as status,
      b.created_at,
      coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct')  as source,
      coalesce(tl.label, t.name, bt.name, 'Unknown')                    as tour,
      biz.name                                                          as business
    from bookings b
    join business_tours bt on bt.id = b.business_tour_id
    join businesses biz on biz.id = b.business_id
    left join tours t on t.id = bt.tour_id
    left join tour_analytics_labels tl on tl.tour_id = t.id
    left join customers c on c.id = b.customer_id
    left join booking_source_labels l
           on lower(l.channel) = lower(btrim(b.source_channel))
    where b.starts_at >= p_start
      and b.starts_at <  p_end
      and b.status <> 'cancelled'
      and (p_business_id is null or b.business_id = p_business_id)
  )
  select id, starts_at, customer, pax, status, created_at, source, tour, business
  from rows
  where (p_source is null or source = p_source)
    and (p_tour   is null or tour   = p_tour)
  order by starts_at, customer
  limit 300
$$;
