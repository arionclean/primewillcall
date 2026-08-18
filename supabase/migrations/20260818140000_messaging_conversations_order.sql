-- Order and bound the conversation list in the database.
--
-- messaging_conversations() returned every conversation in whatever order the
-- planner produced them, and the account already has more than a thousand. A
-- single PostgREST read is capped at 1000 rows, so the browser received an
-- arbitrary thousand and sorted those: a brand new conversation could be cut
-- off entirely and never appear, which is exactly what happened to the first
-- real WhatsApp thread. Sorting client-side cannot fix that, because the row
-- was already gone before it arrived.
--
-- Newest first, in SQL, with an explicit limit the caller can raise.

drop function if exists public.messaging_conversations();

create or replace function public.messaging_conversations(p_limit integer default 500)
returns table (
  counterpart text,
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
  )
  select n.counterpart, n.last_body, n.last_direction, n.last_at, n.last_channel,
         t.message_count, t.has_sms, t.has_whatsapp,
         coalesce(t.has_whatsapp and exists (
           select 1 from public.whatsapp_messages w
           where w.direction = 'inbound'
             and w.from_phone = n.counterpart
             and w.created_at > now() - interval '24 hours'
         ), false) as whatsapp_window_open
  from newest n
  join totals t on t.counterpart = n.counterpart
  order by n.last_at desc
  limit greatest(coalesce(p_limit, 500), 1)
$$;

grant execute on function public.messaging_conversations(integer) to authenticated;
