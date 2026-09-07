-- The Employees page activity feed, built for volume.
--
-- Every tablet posts a steady stream into kiosk_events (housekeeping alone is dozens
-- of rows per tablet per hour), so the page must never pull a day into memory.
-- kiosk_activity() is the one place the filters and the keyset paging live: the page
-- renders the first 100 rows, "Load more" continues from the last (at, id), and the
-- count comes from kiosk_activity_count() with the same filters. Both are SECURITY
-- INVOKER, so kiosk_events RLS still scopes them by business.
--
-- Tablet housekeeping (level = 'debug') is hidden unless asked for, which is what
-- keeps the default view readable; the partial indexes below make that default and
-- the "problems only" view cheap on a large table.

create index if not exists kiosk_events_nondebug_at_idx
  on public.kiosk_events (at desc, id desc) where level <> 'debug';
create index if not exists kiosk_events_problems_at_idx
  on public.kiosk_events (at desc, id desc) where level in ('warn', 'error');
create index if not exists kiosk_events_event_at_idx
  on public.kiosk_events (event, at desc);

create or replace function public.kiosk_activity(
  p_from timestamptz,
  p_to timestamptz,
  p_employee uuid default null,
  p_kiosk text default null,
  p_events text[] default null,
  p_problems boolean default false,
  p_include_debug boolean default false,
  p_search text default null,
  p_before_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 100
)
returns table (
  id bigint,
  at timestamptz,
  event text,
  level text,
  ref text,
  payload jsonb,
  kiosk_slug text,
  employee_id uuid,
  employee_name text,
  app_build text
)
language sql
stable
security invoker
set search_path = public
as $$
  select e.id, e.at, e.event, e.level, e.ref, e.payload, e.kiosk_slug,
         e.employee_id, e.employee_name, e.app_build
    from public.kiosk_events e
   where e.at >= p_from and e.at < p_to
     and (p_employee is null or e.employee_id = p_employee)
     and (p_kiosk is null or e.kiosk_slug = p_kiosk)
     and (p_events is null or e.event = any (p_events))
     and (not p_problems or e.level in ('warn', 'error'))
     and (p_include_debug or e.level <> 'debug')
     and (
       p_search is null or btrim(p_search) = ''
       or e.ref ilike '%' || btrim(p_search) || '%'
       or e.employee_name ilike '%' || btrim(p_search) || '%'
       or e.event ilike '%' || replace(btrim(p_search), ' ', '_') || '%'
       or e.payload::text ilike '%' || btrim(p_search) || '%'
     )
     and (
       p_before_at is null
       or e.at < p_before_at
       or (e.at = p_before_at and e.id < coalesce(p_before_id, 0))
     )
   order by e.at desc, e.id desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create or replace function public.kiosk_activity_count(
  p_from timestamptz,
  p_to timestamptz,
  p_employee uuid default null,
  p_kiosk text default null,
  p_events text[] default null,
  p_problems boolean default false,
  p_include_debug boolean default false,
  p_search text default null
)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)
    from public.kiosk_events e
   where e.at >= p_from and e.at < p_to
     and (p_employee is null or e.employee_id = p_employee)
     and (p_kiosk is null or e.kiosk_slug = p_kiosk)
     and (p_events is null or e.event = any (p_events))
     and (not p_problems or e.level in ('warn', 'error'))
     and (p_include_debug or e.level <> 'debug')
     and (
       p_search is null or btrim(p_search) = ''
       or e.ref ilike '%' || btrim(p_search) || '%'
       or e.employee_name ilike '%' || btrim(p_search) || '%'
       or e.event ilike '%' || replace(btrim(p_search), ' ', '_') || '%'
       or e.payload::text ilike '%' || btrim(p_search) || '%'
     );
$$;

grant execute on function public.kiosk_activity(timestamptz, timestamptz, uuid, text, text[], boolean, boolean, text, timestamptz, bigint, integer) to authenticated;
grant execute on function public.kiosk_activity_count(timestamptz, timestamptz, uuid, text, text[], boolean, boolean, text) to authenticated;
