-- The conversation list stops scanning every customer.
--
-- messaging_conversations named each conversation by folding ALL of customers (93k
-- rows, most of them from the Xano import) into a keyed CTE on every call: a regexp
-- over every phone, a GROUP BY over the result and, because the function is SECURITY
-- INVOKER, the customers RLS policy evaluated on every one of those rows. That took
-- 0.6 to 3.4 seconds for a page of 50, ran again on every incoming text (the Messages
-- screen refreshes the list on each Realtime insert) and, under load, crossed the
-- 8 second statement timeout of the authenticated role, which staff saw as
-- "Could not load conversations".
--
-- A name is only needed for the rows on the page, so the page is built first and each
-- of its rows then looks its customer up by key. The key is the last ten digits of the
-- number, because customers.phone is a mix of '+13051234567', '3051234567' and
-- formatted legacy values, so equality on the raw column misses half of them.
--
-- The key is a real generated column (customers.phone_last10) rather than an
-- expression index, and that is not a style choice. Under row level security Postgres
-- only uses a WHERE clause as an index condition when every function in it is
-- LEAKPROOF, because a leaky function could reveal rows the policy hides through its
-- error messages. regexp_replace() is not leakproof, so an index on
-- right(regexp_replace(phone, ...), 10) is used by the table owner and silently ignored
-- for the authenticated role: that version ran in 0.5 s as postgres and timed out at
-- 8 s as a staff member. A plain column compared with = (texteq, which is leakproof)
-- may use its index for everyone.
--
-- Search by name is the one case that has to look past the page. It is an EXISTS on
-- the same key, so it still probes the index rather than scanning.
-- Same signature, same result shape, same row order; only the plan changes.

alter table public.customers
  add column phone_last10 text
    generated always as (right(regexp_replace(phone, '\D', '', 'g'), 10)) stored;

comment on column public.customers.phone_last10 is
  'Last ten digits of phone, maintained by Postgres. The key messaging_conversations names a conversation by: customers.phone is stored in mixed formats, and under RLS only a plain column compared with = can use an index (regexp_replace is not leakproof).';

create index customers_phone_last10_idx on public.customers (phone_last10);

create or replace function public.messaging_conversations(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_search text default null
)
returns table (
  counterpart text,
  customer_name text,
  last_body text,
  last_direction text,
  last_at timestamptz,
  last_channel text,
  message_count bigint,
  has_sms boolean,
  has_whatsapp boolean,
  whatsapp_window_open boolean
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  with scoped as (
    select case when direction = 'inbound' then from_phone else to_phone end as counterpart,
           body, direction::text as direction, created_at, 'sms'::text as channel
    from public.sms_messages
    union all
    select case when direction = 'inbound' then from_phone else to_phone end as counterpart,
           body, direction::text as direction, created_at, 'whatsapp'::text as channel
    from public.whatsapp_messages
  ),
  -- One pass over the messages: the newest row of each conversation carries the totals
  -- as window aggregates, so nothing is joined back. (A DISTINCT ON joined to a GROUP BY
  -- read the same, but with the parameters unknown the planner guessed a few dozen rows
  -- out of that join and chose a nested loop that compared every conversation with every
  -- other one: five million comparisons, half a second, on every call.)
  ranked as (
    select counterpart, body, direction, created_at, channel,
           row_number() over newest_first as rn,
           count(*) over whole as message_count,
           bool_or(channel = 'sms') over whole as has_sms,
           bool_or(channel = 'whatsapp') over whole as has_whatsapp
    from scoped
    window whole as (partition by counterpart),
           newest_first as (partition by counterpart order by created_at desc)
  ),
  needle as (
    select nullif(btrim(coalesce(p_search, '')), '') as text,
           nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '') as digits
  ),
  -- The page is settled before any customer is read, so the name lookup below runs
  -- once per row shown, not once per conversation that exists.
  page as (
    select r.counterpart, r.body as last_body, r.direction as last_direction,
           r.created_at as last_at, r.channel as last_channel,
           r.message_count, r.has_sms, r.has_whatsapp,
           nullif(right(regexp_replace(r.counterpart, '\D', '', 'g'), 10), '') as phone_last10
    from ranked r
    cross join needle s
    where r.rn = 1
      and (p_before is null or r.created_at < p_before)
      and (
        s.text is null
        or (s.digits is not null and regexp_replace(r.counterpart, '\D', '', 'g') like '%' || s.digits || '%')
        or exists (
          select 1 from public.customers cu
          where cu.phone_last10 = right(regexp_replace(r.counterpart, '\D', '', 'g'), 10)
            and cu.full_name ilike '%' || s.text || '%'
        )
      )
    order by r.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  )
  select p.counterpart,
         -- "order by full_name limit 1" keeps the old min(full_name) pick when several
         -- customer rows share a number.
         (select cu.full_name
            from public.customers cu
           where cu.phone_last10 = p.phone_last10
             and cu.full_name is not null
           order by cu.full_name
           limit 1) as customer_name,
         p.last_body, p.last_direction, p.last_at, p.last_channel,
         p.message_count, p.has_sms, p.has_whatsapp,
         coalesce(p.has_whatsapp and exists (
           select 1 from public.whatsapp_messages w
           where w.direction = 'inbound'
             and w.from_phone = p.counterpart
             and w.created_at > now() - interval '24 hours'
         ), false) as whatsapp_window_open
  from page p
  order by p.last_at desc
$$;

grant execute on function public.messaging_conversations(integer, timestamptz, text) to authenticated;

-- The other half of the cost was the policy itself. Each messaging policy was written
-- as EXISTS (select 1 from current_staff() cs where cs.role = 'owner' or
-- cs.business_id = <row>.business_id). Because the subquery mentions the row, it is a
-- correlated SubPlan: current_staff() (SECURITY DEFINER, so never inlined) runs once
-- per row scanned, 7k times for the conversation list, and that alone was most of the
-- 0.6 s a staff member waited while the same query took 30 ms as the table owner.
--
-- Written as two uncorrelated scalar subqueries, the planner turns each into an
-- InitPlan evaluated once per statement. Same truth table: no staff row (inactive or
-- unknown user) yields NULL on both sides of the OR, which RLS treats as denied, exactly
-- as the empty EXISTS did.

drop policy sms_messages_select on public.sms_messages;
create policy sms_messages_select on public.sms_messages
  for select to authenticated
  using (
    (select cs.role from public.current_staff() cs) = 'owner'
    or business_id = (select cs.business_id from public.current_staff() cs)
  );

drop policy whatsapp_messages_select on public.whatsapp_messages;
create policy whatsapp_messages_select on public.whatsapp_messages
  for select to authenticated
  using (
    (select cs.role from public.current_staff() cs) = 'owner'
    or business_id = (select cs.business_id from public.current_staff() cs)
  );

drop policy whatsapp_messages_insert on public.whatsapp_messages;
create policy whatsapp_messages_insert on public.whatsapp_messages
  for insert to authenticated
  with check (
    (select cs.role from public.current_staff() cs) = 'owner'
    or (
      (select cs.role from public.current_staff() cs) = 'business_manager'
      and business_id = (select cs.business_id from public.current_staff() cs)
    )
  );
