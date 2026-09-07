-- Kiosk card flow v2: sale-first card payments, a per-kiosk switch, and an event stream.
--
-- Why. On 2026-09-04 a kiosk3 customer was charged twice: the reader captured a
-- payment, the tablet reported a failure, staff re-ran the card under a new sale
-- reference, and nothing anywhere recorded the first charge. The old flow only
-- writes the sale AFTER staff finish a form that appears once the card has been
-- charged, so any interruption between capture and that form loses the sale.
--
-- v2 inverts the order. The tablet sends the whole sale (customer, pax, tour,
-- the Xano record it would have posted) BEFORE the card is read; the server
-- writes a hidden pending booking and creates the PaymentIntent for it; the
-- webhook plus a one-minute sweep can finish the sale even if the tablet dies.
-- Retries reuse the same sale and intent, so a second tap can never be a second
-- charge. See docs/kiosk-card-flow-v2.md.
--
-- Everything here is additive. The old app never reads these columns or tables,
-- and every kiosk stays on card_flow = 'v1' until the owner flips it.

-- ── Per-kiosk switch + reader battery thresholds ─────────────────────────────
alter table public.kiosks
  add column if not exists card_flow text not null default 'v1',
  add column if not exists reader_low_battery_pct integer not null default 25,
  add column if not exists reader_block_battery_pct integer not null default 10;

alter table public.kiosks drop constraint if exists kiosks_card_flow_check;
alter table public.kiosks
  add constraint kiosks_card_flow_check check (card_flow in ('v1', 'v2'));
alter table public.kiosks drop constraint if exists kiosks_reader_battery_check;
alter table public.kiosks
  add constraint kiosks_reader_battery_check
  check (reader_block_battery_pct between 0 and 100
     and reader_low_battery_pct between 0 and 100
     and reader_block_battery_pct <= reader_low_battery_pct);

comment on column public.kiosks.card_flow is
  'v1 = today''s tablet flow (charge first, record after the name form). v2 = sale-first flow with server completion (docs/kiosk-card-flow-v2.md). Read by the tablet at login via kiosk-config; an old build ignores it.';
comment on column public.kiosks.reader_low_battery_pct is
  'Reader battery percentage at which the tablet shows "Charge the reader" (v2 builds only).';
comment on column public.kiosks.reader_block_battery_pct is
  'Reader battery percentage below which the tablet refuses to start a card payment (v2 builds only).';

-- ── kiosk_sales: one row per v2 card sale, written BEFORE the card is read ────
create table if not exists public.kiosk_sales (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,                       -- the KS-XXXXXXXX code
  kiosk_id          uuid not null references public.kiosks(id),
  kiosk_slug        text not null,
  business_id       uuid not null references public.businesses(id),
  type              text not null default 'card' check (type in ('card')),
  amount_cents      integer not null check (amount_cents > 0),
  product           text,
  customer_name     text,
  status            text not null default 'pending'
                    check (status in ('pending', 'paid', 'abandoned')),
  payment_intent_id text,
  stripe_account_id text,
  booking_id        uuid references public.bookings(id) on delete set null,
  cash_sale_id      uuid references public.cash_sales(id) on delete set null,
  xano_payload      jsonb not null default '{}'::jsonb,         -- the record the tablet would have posted to Xano
  xano_booking_id   text,
  xano_payment_qr   text,
  xano_mirrored_at  timestamptz,
  xano_error        text,
  paid_at           timestamptz,
  completed_at      timestamptz,
  completed_by      text check (completed_by in ('tablet', 'sweep', 'reuse')),
  tablet_acked_at   timestamptz,                                -- the tablet saw the paid outcome
  app_build         text,
  device_id         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.kiosk_sales is
  'Kiosk card flow v2: the sale exists (pending) before the card is read; paid when Stripe confirms, by the tablet or by the kiosk-sale-sweep cron. Never written by clients: service role only (kiosk-sale-start / kiosk-sale-complete / kiosk-sale-sweep).';
comment on column public.kiosk_sales.completed_by is
  'tablet = the tablet reported the outcome; sweep = the cron found the intent succeeded after the tablet went quiet; reuse = a retried sale on the same kiosk was attached to this already-captured payment instead of charging again.';

create index if not exists kiosk_sales_kiosk_created_idx on public.kiosk_sales (kiosk_id, created_at desc);
create index if not exists kiosk_sales_pending_idx on public.kiosk_sales (created_at) where status = 'pending';
create index if not exists kiosk_sales_mirror_retry_idx on public.kiosk_sales (created_at)
  where status = 'paid' and xano_booking_id is null;

drop trigger if exists kiosk_sales_set_updated_at on public.kiosk_sales;
create trigger kiosk_sales_set_updated_at before update on public.kiosk_sales
  for each row execute function public.set_updated_at();

alter table public.kiosk_sales enable row level security;
drop policy if exists kiosk_sales_select on public.kiosk_sales;
create policy kiosk_sales_select on public.kiosk_sales
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or ((cs.role = 'business_manager' or cs.role = 'check_in') and cs.business_id = kiosk_sales.business_id)
    )
  );
-- No insert/update/delete policies on purpose: only the edge functions (service role) write.

-- ── kiosk_events: what the tablets see, kept for months ─────────────────────
create table if not exists public.kiosk_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),               -- server receive time
  client_at   timestamptz,                                       -- the tablet's clock
  kiosk_id    uuid references public.kiosks(id) on delete set null,
  kiosk_slug  text,
  business_id uuid references public.businesses(id) on delete set null,
  ref         text,                                              -- KS code when the event belongs to a sale
  event       text not null,
  level       text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  payload     jsonb not null default '{}'::jsonb,
  app_build   text,
  device_id   text
);

comment on table public.kiosk_events is
  'Append-only stream from the PrimeKiosk tablets (kiosk-log) and the kiosk sale functions: reader connected/dropped/battery, sale started, card result with the SDK error text, sale completed, mirror results. Correlate on ref (the KS code) with kiosk_sales, cash_sales.booking_ref, bookings.legacy_id and stripe_transactions.booking_ref.';

create index if not exists kiosk_events_kiosk_at_idx on public.kiosk_events (kiosk_id, at desc);
create index if not exists kiosk_events_at_idx on public.kiosk_events (at desc);
create index if not exists kiosk_events_ref_idx on public.kiosk_events (ref) where ref is not null;

alter table public.kiosk_events enable row level security;
drop policy if exists kiosk_events_select on public.kiosk_events;
create policy kiosk_events_select on public.kiosk_events
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or ((cs.role = 'business_manager' or cs.role = 'check_in') and cs.business_id = kiosk_events.business_id)
    )
  );

-- Live feed for a future kiosks admin screen. Inserts only, so no REPLICA IDENTITY change.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kiosk_events'
  ) then
    alter publication supabase_realtime add table public.kiosk_events;
  end if;
end $$;

-- ── The sweep: every minute, finish or expire pending v2 sales ───────────────
-- Same shape as the messaging dispatcher job: pg_cron -> edge function, authenticated
-- with the vault secret the function compares against its CRON_SECRET.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'kiosk-sale-sweep') then
    perform cron.unschedule('kiosk-sale-sweep');
  end if;
end $$;

select cron.schedule(
  'kiosk-sale-sweep',
  '* * * * *',
  $cron$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/kiosk-sale-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $cron$
);
