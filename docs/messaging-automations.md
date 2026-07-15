# Messaging automations (with waits)

Owner-built rules that text customers automatically when a booking comes in. Edited at
`/admin/messaging` (Automations tab). This doc covers the data model, the "wait" delivery
path, and the checklist to make it actually send in production.

## The model

An **automation** is a **trigger** plus one or more **actions**:

- **Identity**: `messaging_rules.automation_id`. Rows sharing this id are one automation.
  This is what lets two automations share the same trigger and product without merging
  (added in `20260712120000_messaging_rules_automation_id.sql`; backfilled by the old
  trigger+product grouping). Creating a message with no `automation_id` starts a new
  automation (the column default mints a fresh id); "Add action" passes the existing id.
- **Trigger**: `trigger_event` (only `new_booking` today) + `business_tour_id` (the
  product, `null` = any product). Shared across an automation's rows; changing the product
  moves them all (scoped by `automation_id`, so it never merges two automations).
- **Action**: a single `messaging_rules` row (a message). Each has a `channel`
  (`sms` / `whatsapp`), the body or WhatsApp template, `only_first_contact`, `is_active`,
  and `delay_minutes`. Messages have no user-facing name; the row's `name` is auto-derived
  for storage and the UI shows the message content.

**Waits**: the builder treats an automation as a SEQUENCE. A Wait node is the gap
between the previous step and the next message ("wait 1 day, then continue"); editing a
gap shifts that message and every step after it. Storage stays absolute:
`messaging_rules.delay_minutes` is each message's total delay from the trigger (the sum
of the gaps above it, 0 = immediately, max 30 days = `43200`), because that is what the
send queue schedules on. `updateWaitGapAction` does the gap-to-absolute math.

## How firing works (DB-triggered, page-independent)

Firing lives in the **database**, not in app code, so it works for a booking from ANY
source, not just whichever page remembered to call it. Everything funnels through one
queue and one sender, and that sender enforces a hard spend cap.

1. A booking row is inserted. An `AFTER INSERT` trigger on `bookings`,
   `WHEN (NEW.legacy_id IS NULL)`, runs `on_native_booking_created()`. The `legacy_id IS
   NULL` clause means it fires only for **Supabase-native** bookings and **never** for the
   ~90k Xano-synced rows (which still have Xano do their texting). It also no-ops unless
   `messaging_settings.automations_enabled` is true.
2. The trigger `pg_net`-POSTs the booking id to the **`run-booking-automations`** edge
   function (enqueue only, never calls Twilio). It matches the active rules for the
   product, renders each, and inserts rows into `public.scheduled_messages`
   (`send_at = now + delay_minutes`, immediate = `now`). Idempotent per booking.
3. `pg_cron` calls **`dispatch-scheduled-messages`** every minute. It enforces the
   **global hourly cap** (see below), `claim_due_scheduled_messages()` up to the remaining
   budget (atomic `FOR UPDATE SKIP LOCKED`), sends via Twilio, marks `sent` / `failed`.

The old inline path (`maybeRunNewBookingRules` in `src/lib/sms/rules.ts`, called from
`/schedule`) is **retired** — it bypassed the cap and would double-send alongside the
trigger. `rules.ts` is kept only as the reference the edge function was ported from.

## Guardrails (money safety)

`public.messaging_settings` (single row) is the control panel; everything defaults to safe:

- `automations_enabled` (default **false**) — the master kill switch. Off = the trigger
  does nothing and nothing is enqueued.
- `sms_hourly_cap` (default **100**) — the dispatcher never sends more than this many
  messages per rolling hour, globally. Overflow stays `pending` (delayed, **not dropped**)
  and drains on later runs. This makes a runaway spend impossible regardless of how many
  bookings flood in.
- `alert_phone` — when the cap actively throttles work, the dispatcher logs a
  `public.messaging_alerts` row and (if this is set) texts an alert naming the top
  products/sources filling the queue. Deduped to once per hour. **SMS only** — it cannot
  be an email address.
- `booking_link_base` — base for `{{booking_link}}` (set to the app's `/booking`).

To turn automations on: set `messaging_settings.automations_enabled = true`, make sure
`run-booking-automations` has the `CRON_SECRET` function secret (same value as the
dispatcher), and set `alert_phone`. Migration:
`supabase/migrations/20260712140000_booking_automations_guardrails.sql`. Queue tables/RPC:
`supabase/migrations/20260711120000_scheduled_messages.sql`.

## Go-live checklist

Status on project `qbnizuhozzwkiitfkjee` (as of 2026-07-12):

- [x] Schema migrations applied (`scheduled_messages`, `delay_minutes`, `automation_id`).
- [x] Dispatcher edge function `dispatch-scheduled-messages` deployed and ACTIVE (JWT off).
- [x] `pg_cron` + `pg_net` enabled; `CRON_SECRET` in Vault (`dispatch_cron_secret`); the
      every-minute cron job is scheduled and active.
- [x] Edge-function secrets set (`CRON_SECRET` + the four Twilio values) and **verified
      end to end**: a test row queued to a real number was sent (cron -> function 200 ->
      Twilio `SM...` SID -> row `sent`).
- [ ] **Wire the Groupon path** (step 4 below).
- [ ] **Flip `MESSAGING_AUTOMATIONS_ENABLED=true`** on the Next app (step 5).

Remaining steps to turn sending on:

1. **Twilio env on the Next app** (Vercel), for the *inline* (delay 0) sends:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WHATSAPP_FROM`,
   and `BOOKING_LINK_BASE_URL` (set to `https://<app-domain>/booking`, not the bked.io
   default, so ticket links hit the new app's page).
2. ~~Deploy the dispatcher~~ (done). To redeploy after code changes:
   `supabase functions deploy dispatch-scheduled-messages --no-verify-jwt`. Its secrets
   (`TWILIO_*`, `CRON_SECRET`) are set on the function; the cron reads `CRON_SECRET` from Vault.
3. ~~Schedule the cron~~ (done; SQL kept below for reference / disaster recovery).
4. **Wire the other booking path**: add the same `maybeRunNewBookingRules({...})` call after
   the booking insert in `src/app/api/gp/book/route.ts` (the internal `/schedule` flow is
   already wired in `src/app/(app)/schedule/actions.ts`). Until then, Groupon (`/gp`)
   bookings never enqueue or fire any automation.
5. **Flip it on**: set `MESSAGING_AUTOMATIONS_ENABLED=true` on the Next app — but only once
   Xano no longer sends the same booking texts, or customers get double-messaged.

### pg_cron SQL (step 3)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Same value as the edge function's CRON_SECRET.
select vault.create_secret('<CRON_SECRET>', 'dispatch_cron_secret');

select cron.schedule(
  'dispatch-scheduled-messages',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/dispatch-scheduled-messages',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
```

## Known gaps / follow-ups

- **Delayed sends are not yet mirrored into `sms_messages`**, so they will not appear in the
  Messages inbox and do not count toward the "first time we ever texted this number" check
  (that check runs at enqueue time). Immediate sends still log normally.
- **No retry**: a failed dispatch is marked `failed`, not retried. Add an attempts-based
  requeue if Twilio flakiness becomes an issue.
- **`only_first_contact` is evaluated at enqueue time**, not at send time.
