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

## How a wait actually fires

1. A booking is created and calls `maybeRunNewBookingRules(ctx)`
   (`src/lib/sms/rules.ts`). Gated by `MESSAGING_AUTOMATIONS_ENABLED` and never throws.
2. `runNewBookingRules` loads the matching active rules. For each:
   - `delay_minutes === 0` -> send **inline** via Twilio (unchanged behaviour).
   - `delay_minutes > 0` -> render now and **enqueue** a row in `public.scheduled_messages`
     with `send_at = now + delay` (a later edit to the rule does not rewrite what is queued).
3. `pg_cron` calls the **`dispatch-scheduled-messages`** edge function every minute. It
   `claim_due_scheduled_messages()` (atomic `FOR UPDATE SKIP LOCKED`, so concurrent runs
   never double-send), sends each due row through Twilio, and marks it `sent` / `failed`.

Tables/functions live in `supabase/migrations/20260711120000_scheduled_messages.sql`.

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
