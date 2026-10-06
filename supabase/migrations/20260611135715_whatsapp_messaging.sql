-- Recovered on 2026-09-17 from the database's migration log (applied 2026-06-11
-- 13:57 UTC). It only ever lived on the feat/whatsapp-messaging branch, so main
-- altered whatsapp_messages (20260816170000_whatsapp_inbound and later) without
-- ever creating it, and had no businesses.whatsapp_number. Verbatim what ran. The
-- later migrations on main reshape the policies and the status check; this is the
-- starting point they assume.

-- WhatsApp messaging: per-business sender number + an immutable send log.
--
-- Each business gets its own WhatsApp number, registered as a sender under
-- Prime's single Twilio account (the owner sets it on the business edit page).
-- Staff send booking confirmations from the Bookings page through a server
-- action; every attempt is logged here, success or failure, so there is an
-- audit trail of what was sent to whom.

alter table public.businesses
  add column if not exists whatsapp_number text;

comment on column public.businesses.whatsapp_number is
  'WhatsApp sender for this business (digits only, US 10-digit), registered under the platform Twilio account. Null disables sending.';

-- ── Send log ────────────────────────────────────────────────────────────────
create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  to_phone text not null,
  from_phone text not null,
  body text not null,
  status text not null check (status in ('sent', 'failed')),
  twilio_sid text,
  error text,
  sent_by_staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_messages_business_idx
  on public.whatsapp_messages (business_id, created_at desc);
create index if not exists whatsapp_messages_booking_idx
  on public.whatsapp_messages (booking_id);

alter table public.whatsapp_messages enable row level security;
revoke all on table public.whatsapp_messages from anon;

-- Owner sees everything; a business's staff see their own log.
drop policy if exists whatsapp_messages_select on public.whatsapp_messages;
create policy whatsapp_messages_select on public.whatsapp_messages
  for select to authenticated
  using (exists (
    select 1 from public.current_staff() cs
    where cs.role = 'owner'::public.staff_role
       or cs.business_id = whatsapp_messages.business_id
  ));

-- Owner and the business's manager can log sends (the server action inserts
-- as the signed-in user). Check-in staff cannot send messages.
drop policy if exists whatsapp_messages_insert on public.whatsapp_messages;
create policy whatsapp_messages_insert on public.whatsapp_messages
  for insert to authenticated
  with check (exists (
    select 1 from public.current_staff() cs
    where cs.role = 'owner'::public.staff_role
       or (cs.role = 'business_manager'::public.staff_role
           and cs.business_id = whatsapp_messages.business_id)
  ));

-- No update/delete policies on purpose: the log is immutable from the app.
