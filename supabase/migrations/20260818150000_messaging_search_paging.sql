-- Search and keyset paging for the conversation list.
--
-- The list was capped at 500 while the account already has more than a thousand
-- conversations, so the older half could not be reached by browsing at all. And
-- at this size scrolling is not how anyone finds a person: they type a name or
-- a number.
--
-- Paging is keyset (last_at < p_before) rather than offset, so a message
-- arriving mid-scroll cannot shift rows across a page boundary and make one
-- appear twice or vanish.
--
-- Names come from customers, matched on the last ten digits: customers.phone
-- holds a mix of '+13051234567' and '3051234567', so a plain equality join
-- silently misses half of them. The customer set is folded once into a keyed
-- CTE instead of a lookup per conversation.

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
  newest as (
    select distinct on (counterpart)
      counterpart, body as last_body, direction as last_direction,
      created_at as last_at, channel as last_channel
    from scoped
    order by counterpart, created_at desc
  ),
  totals as (
    select counterpart,
           count(*) as message_count,
           bool_or(channel = 'sms') as has_sms,
           bool_or(channel = 'whatsapp') as has_whatsapp
    from scoped
    group by counterpart
  ),
  cust as (
    select right(regexp_replace(phone, '\D', '', 'g'), 10) as digits,
           min(full_name) as full_name
    from public.customers
    where phone is not null and full_name is not null
    group by 1
  ),
  needle as (
    select nullif(btrim(coalesce(p_search, '')), '') as text,
           nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '') as digits
  )
  select n.counterpart, c.full_name as customer_name, n.last_body, n.last_direction,
         n.last_at, n.last_channel, t.message_count, t.has_sms, t.has_whatsapp,
         coalesce(t.has_whatsapp and exists (
           select 1 from public.whatsapp_messages w
           where w.direction = 'inbound'
             and w.from_phone = n.counterpart
             and w.created_at > now() - interval '24 hours'
         ), false) as whatsapp_window_open
  from newest n
  join totals t on t.counterpart = n.counterpart
  left join cust c on c.digits = right(regexp_replace(n.counterpart, '\D', '', 'g'), 10)
  cross join needle s
  where (p_before is null or n.last_at < p_before)
    and (
      s.text is null
      or (s.digits is not null and regexp_replace(n.counterpart, '\D', '', 'g') like '%' || s.digits || '%')
      or c.full_name ilike '%' || s.text || '%'
    )
  order by n.last_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

grant execute on function public.messaging_conversations(integer, timestamptz, text) to authenticated;
