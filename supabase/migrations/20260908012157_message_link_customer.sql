-- Every message row carries its customer's business, so a business manager reads
-- the whole thread and not only the half that came in through our own webhook.
--
-- sms_messages is scoped by business_id: a manager sees the rows whose business is
-- theirs. Rows our own paths write (chat sends, the inbound webhook, the dispatcher)
-- were linked to a customer by phone inside the edge function, but the rows sms-sync
-- copies in from Twilio (everything Xano sends: confirmations, review asks,
-- reminders) were stored bare. 6,025 of 7,581 rows had no business, so a manager
-- opening a thread saw only the guest's replies, never what was sent to them.
--
-- The link now lives in Postgres, once, as a BEFORE INSERT trigger on both message
-- tables, so every writer (sync, webhook, chat, a future importer) gets the same
-- answer. It matches on customers.phone_last10, the key messaging_conversations
-- already uses, which also covers the formatted legacy phones that the edge
-- function's exact-variant lookup missed.
--
-- A phone can belong to customers in more than one business (3,669 do). The rule:
-- the customer with the most recent booking created at or before the message,
-- because a text is about the booking that preceded it; then the most recent
-- booking of any date; then the newest customer. A writer that already named the
-- business (sms-send stamps the sender's, the dispatcher the rule's) keeps it, and
-- the customer is then preferred from that business. Only NULL columns are filled.

create or replace function public.message_link_customer(
  p_phone text,
  p_at timestamptz,
  p_business_id uuid default null
)
returns table (customer_id uuid, business_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  with key as (
    select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10) as last10
  )
  select c.id, c.business_id
  from key
  join public.customers c on c.phone_last10 = key.last10
  left join lateral (
    select b.created_at
    from public.bookings b
    where b.customer_id = c.id
    order by (b.created_at <= p_at) desc, b.created_at desc
    limit 1
  ) b on true
  where length(key.last10) = 10
  order by (p_business_id is not null and c.business_id = p_business_id) desc,
           (b.created_at is not null and b.created_at <= p_at) desc,
           b.created_at desc nulls last,
           c.created_at desc
  limit 1
$$;

comment on function public.message_link_customer(text, timestamptz, uuid) is
  'The customer (and so the business) a message to or from p_phone belongs to at p_at. Used by the link_message_customer trigger and its one-time backfill.';

revoke execute on function public.message_link_customer(text, timestamptz, uuid)
  from public, anon, authenticated;

create or replace function public.link_message_customer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  l record;
begin
  if new.customer_id is not null and new.business_id is not null then
    return new;
  end if;

  if new.customer_id is not null then
    select c.business_id into l from public.customers c where c.id = new.customer_id;
    new.business_id := l.business_id;
    return new;
  end if;

  select * into l
  from public.message_link_customer(
    case when new.direction = 'inbound' then new.from_phone else new.to_phone end,
    coalesce(new.created_at, now()),
    new.business_id
  );
  if found then
    new.customer_id := l.customer_id;
    new.business_id := coalesce(new.business_id, l.business_id);
  end if;
  return new;
end
$$;

comment on function public.link_message_customer() is
  'BEFORE INSERT on sms_messages and whatsapp_messages: fills customer_id and business_id from the counterpart phone when the writer left them NULL. The business is what RLS scopes managers by.';

drop trigger if exists sms_messages_link_customer on public.sms_messages;
create trigger sms_messages_link_customer
  before insert on public.sms_messages
  for each row execute function public.link_message_customer();

drop trigger if exists whatsapp_messages_link_customer on public.whatsapp_messages;
create trigger whatsapp_messages_link_customer
  before insert on public.whatsapp_messages
  for each row execute function public.link_message_customer();

-- One time: the rows sms-sync already copied in bare.
update public.sms_messages m
set customer_id = coalesce(m.customer_id, l.customer_id),
    business_id = l.business_id
from (
  select m2.id, l.customer_id, l.business_id
  from public.sms_messages m2
  cross join lateral public.message_link_customer(
    case when m2.direction = 'inbound' then m2.from_phone else m2.to_phone end,
    m2.created_at,
    null
  ) l
  where m2.business_id is null
) l
where l.id = m.id;
