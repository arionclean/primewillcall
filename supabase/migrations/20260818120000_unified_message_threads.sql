-- Unified messaging threads: one conversation view over SMS + WhatsApp.
--
-- The two channels live in separate tables on purpose (WhatsApp carries a
-- 24-hour window and template rules that SMS does not), but staff talk to one
-- person, not to a channel. These two functions are the join point, done in the
-- database so the browser never pulls both tables and merges them itself.
--
-- Both are SECURITY INVOKER, so the existing per-business RLS on each table
-- still decides which rows a caller can see.

-- Every message to or from one number, both channels, oldest first.
create or replace function public.messaging_thread(p_counterpart text)
returns table (
  id uuid,
  channel text,
  direction text,
  from_phone text,
  to_phone text,
  body text,
  status text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select id, 'sms'::text as channel, direction::text, from_phone, to_phone,
         body, status, created_at
  from public.sms_messages
  where from_phone = p_counterpart or to_phone = p_counterpart
  union all
  select id, 'whatsapp'::text as channel, direction::text, from_phone, to_phone,
         body, status, created_at
  from public.whatsapp_messages
  where from_phone = p_counterpart or to_phone = p_counterpart
  order by created_at
$$;

-- One row per person: the newest message across both channels, which channels
-- that person has used, and whether WhatsApp free-form is currently allowed.
create or replace function public.messaging_conversations()
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
         -- Inlined rather than calling whatsapp_window_open(), which is SECURITY
         -- DEFINER: one pass over the same scoped rows instead of a probe per row.
         coalesce(t.has_whatsapp and exists (
           select 1 from public.whatsapp_messages w
           where w.direction = 'inbound'
             and w.from_phone = n.counterpart
             and w.created_at > now() - interval '24 hours'
         ), false) as whatsapp_window_open
  from newest n
  join totals t on t.counterpart = n.counterpart
$$;

grant execute on function public.messaging_thread(text) to authenticated;
grant execute on function public.messaging_conversations() to authenticated;
