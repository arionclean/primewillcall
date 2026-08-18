-- WhatsApp inbound + the 24-hour service window.
--
-- WhatsApp is not SMS: a business may only start a conversation with an
-- approved template, but once the customer replies, Meta opens a 24-hour
-- window in which free-form messages are allowed. Each new customer reply
-- restarts it.
--
-- whatsapp_messages was outbound-only, so nothing recorded a customer reply
-- and the window could not be computed. This adds the inbound half:
--   - direction, matching sms_messages
--   - an index that answers "did this number write to us in the last 24h"
--   - whatsapp_window_open(phone), the single source of truth for that answer

alter table public.whatsapp_messages
  add column if not exists direction public.sms_direction not null default 'outbound';

-- business_id was NOT NULL, which only held while every row was outbound and we
-- picked the business ourselves. An inbound message arrives from whoever wants to
-- write to us: the number may match no customer, so there may be no business to
-- name. Keeping the constraint would reject exactly the rows that open the window.
alter table public.whatsapp_messages
  alter column business_id drop not null;

-- status was CHECK (status IN ('sent','failed')), which no real message satisfies:
-- Twilio hands back 'queued' or 'accepted' on an outbound send, and inbound is
-- 'received'. sms_messages stores the provider's own word unconstrained; match it,
-- so the log records what actually happened instead of rejecting the row.
alter table public.whatsapp_messages
  drop constraint if exists whatsapp_messages_status_check;

comment on column public.whatsapp_messages.direction is
  'outbound = we sent it, inbound = the customer did. Inbound rows open the 24h window.';

-- The window lookup is "latest inbound row for this phone", so index that path.
create index if not exists whatsapp_messages_inbound_from_idx
  on public.whatsapp_messages (from_phone, created_at desc)
  where direction = 'inbound';

/**
 * Is the WhatsApp 24-hour service window open for this number?
 *
 * True when the customer messaged us within the last 24 hours, which is exactly
 * when Meta allows a free-form (non-template) reply. Callers that get false must
 * send an approved template instead.
 */
create or replace function public.whatsapp_window_open(p_phone text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.whatsapp_messages
    where direction = 'inbound'
      and from_phone = p_phone
      and created_at > now() - interval '24 hours'
  );
$$;

comment on function public.whatsapp_window_open(text) is
  'True if the customer messaged us on WhatsApp in the last 24h, so a free-form reply is allowed.';

revoke all on function public.whatsapp_window_open(text) from public;
grant execute on function public.whatsapp_window_open(text) to authenticated, service_role;
